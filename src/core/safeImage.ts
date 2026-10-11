import { loadImage, type Image } from "@napi-rs/canvas";

/**
 * Safe image decoding. Skia (inside @napi-rs/canvas) aborts the WHOLE PROCESS when it can't
 * allocate a bitmap ("SkBitmap.cpp: fatal error: assertf(this->tryAllocPixels(...))"): a single
 * 34,372 x 19,345 JPEG, from an attachment or a background URL, took the bot down. Nothing can
 * catch that, so every image is measured from its header first and refused when it's too big to
 * decode safely. Always decode through loadImageSafe, never loadImage directly.
 */

/** At most 5000px on either side (so at most 25 megapixels, 100 MB as RGBA): far beyond any card,
 *  avatar or emoji we draw. */
export const MAX_IMAGE_SIDE = 5000;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export class UnsafeImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeImageError";
  }
}

export type ImageDimensions = { width: number; height: number; format: "png" | "jpeg" | "gif" | "webp" | "bmp" | "svg" };

function svgDimensions(buf: Buffer): ImageDimensions | null {
  const head = buf.subarray(0, 4096).toString("utf8");
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!tag) return null;
  const attr = (name: string) => {
    const value = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)`, "i").exec(tag)?.[1];
    return value ? Number(value) : null;
  };
  let width = attr("width");
  let height = attr("height");
  const viewBox = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if ((!width || !height) && viewBox) {
    width = width ?? Number(viewBox[1]);
    height = height ?? Number(viewBox[2]);
  }
  // Skia's default when an SVG gives no size at all.
  return { width: Math.ceil(width || 150), height: Math.ceil(height || 150), format: "svg" };
}

/** Width and height from the file header, without decoding. Null for formats we don't read. */
export function imageDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }
  if (buf.length >= 10 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: "gif" };
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), format: "webp" };
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), format: "webp" };
    }
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: "webp" };
    return null;
  }
  if (buf.length >= 26 && buf.toString("ascii", 0, 2) === "BM") {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)), format: "bmp" };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk the markers to the frame header (SOF0-SOF15, except DHT/JPG/DAC).
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), format: "jpeg" };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  const text = buf.subarray(0, 512).toString("utf8").trimStart();
  if (text.startsWith("<svg") || text.startsWith("<?xml") || text.startsWith("<!DOCTYPE svg")) return svgDimensions(buf);
  return null;
}

/** Throws UnsafeImageError unless the buffer is a known image format small enough to decode. */
export function assertDecodableImage(buf: Buffer): ImageDimensions {
  if (buf.length > MAX_IMAGE_BYTES) throw new UnsafeImageError("Image file is too large.");
  const dims = imageDimensions(buf);
  if (!dims) throw new UnsafeImageError("Unsupported or unreadable image.");
  if (dims.width <= 0 || dims.height <= 0) throw new UnsafeImageError("Image has no size.");
  if (dims.width > MAX_IMAGE_SIDE || dims.height > MAX_IMAGE_SIDE || dims.width * dims.height > MAX_IMAGE_PIXELS) {
    throw new UnsafeImageError(`Image is too large (${dims.width}x${dims.height}).`);
  }
  return dims;
}

const PRIVATE_HOST =
  /^(?:localhost|.*\.localhost|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

/** Downloads an image URL with a size cap and timeout. http(s) only, never to private addresses. */
export async function fetchImageBuffer(url: string, maxBytes = MAX_IMAGE_BYTES): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeImageError("Invalid image URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new UnsafeImageError("Image URLs must be http(s).");
  if (PRIVATE_HOST.test(parsed.hostname)) throw new UnsafeImageError("That image address isn't allowed.");

  const res = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok || !res.body) throw new UnsafeImageError(`Image request failed (${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new UnsafeImageError("Image file is too large.");

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new UnsafeImageError("Image file is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Decodes an image (buffer, http(s) URL, or data: URI) only after checking it's safe to. */
export async function loadImageSafe(source: Buffer | string): Promise<Image> {
  let buf: Buffer;
  if (Buffer.isBuffer(source)) {
    buf = source;
  } else if (source.startsWith("data:")) {
    const comma = source.indexOf(",");
    if (comma === -1) throw new UnsafeImageError("Invalid data URI.");
    const meta = source.slice(5, comma);
    const body = source.slice(comma + 1);
    buf = meta.includes(";base64") ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  } else {
    buf = await fetchImageBuffer(source);
  }
  assertDecodableImage(buf);
  return loadImage(buf);
}
