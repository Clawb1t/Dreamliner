import { imageDimensions, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from "../safeImage.js";

/**
 * Checks for Server Files uploads (embed images, thumbnails, icons, avatars, card backgrounds).
 * Only the bytes decide what a file is: the claimed type and file name are ignored. PNG, JPEG,
 * GIF and WebP only (animation allowed); SVG (scriptable), HTML renamed to .png and anything else
 * is refused. Text metadata (EXIF/GPS, XMP, IPTC, PNG text chunks) is stripped losslessly,
 * without re-encoding, so animation and quality are kept.
 *
 * Limits are the strictest of the Welcomer upload (4 MB) and core/safeImage (5000px, 25 MP),
 * tightened to 4096 x 4096 so every file also decodes safely wherever the bot draws it. The
 * caller also decodes the file through loadImageSafe and checks the scam-image blocklist.
 */

/** 4 MB: the Welcomer upload limit, and what fits through the website's 4.5 MB request limit. */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const UPLOAD_MAX_SIDE = Math.min(4096, MAX_IMAGE_SIDE);
export const UPLOAD_MAX_PIXELS = Math.min(UPLOAD_MAX_SIDE * UPLOAD_MAX_SIDE, MAX_IMAGE_PIXELS);
/** Animated GIF / WebP: at most this many frames, and this many pixels across all frames. */
export const UPLOAD_MAX_FRAMES = 500;
export const UPLOAD_MAX_ANIMATION_PIXELS = 200_000_000;

/** The limits as one line for the dashboard ("PNG, JPEG, WebP or GIF, up to 4 MB, max 4096 x 4096"). */
export const UPLOAD_LIMITS_TEXT = `PNG, JPEG, WebP or GIF, up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB, max ${UPLOAD_MAX_SIDE} x ${UPLOAD_MAX_SIDE}`;
export const UPLOAD_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type UploadImageType = (typeof UPLOAD_IMAGE_TYPES)[number];

export const UPLOAD_EXTENSION: Record<UploadImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export class UploadValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UploadValidationError";
  }
}

/** The real type from the file's first bytes, or null for anything that isn't png/jpeg/gif/webp. */
export function sniffUploadType(bytes: Buffer): UploadImageType | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export type ValidatedUpload = {
  bytes: Buffer;
  contentType: UploadImageType;
  extension: string;
  width: number;
  height: number;
  frames: number;
};

const FORMAT_TYPE: Record<string, UploadImageType> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Validates an upload and returns the bytes to store (metadata stripped). Throws UploadValidationError. */
export function validateUpload(raw: Buffer, maxBytes = UPLOAD_MAX_BYTES): ValidatedUpload {
  if (!raw.length) throw new UploadValidationError("That file is empty.");
  if (raw.length > maxBytes) throw new UploadValidationError(`That file is too big, the limit is ${megabytes(maxBytes)}.`, 413);

  const contentType = sniffUploadType(raw);
  if (!contentType) throw new UploadValidationError("That file isn't a PNG, JPEG, GIF or WebP image.", 415);

  const dims = imageDimensions(raw);
  if (!dims || FORMAT_TYPE[dims.format] !== contentType) throw new UploadValidationError("That image couldn't be read. It may be damaged.");
  if (dims.width < 1 || dims.height < 1) throw new UploadValidationError("That image has no size.");
  if (dims.width > UPLOAD_MAX_SIDE || dims.height > UPLOAD_MAX_SIDE || dims.width * dims.height > UPLOAD_MAX_PIXELS) {
    throw new UploadValidationError(`That image is ${dims.width} x ${dims.height}. Images can be at most ${UPLOAD_MAX_SIDE} x ${UPLOAD_MAX_SIDE}.`);
  }

  let frames = 1;
  if (contentType === "image/gif" || contentType === "image/webp") {
    const counted = contentType === "image/gif" ? countGifFrames(raw) : countWebpFrames(raw);
    if (counted === null) throw new UploadValidationError("That image couldn't be read. It may be damaged.");
    frames = Math.max(1, counted);
    if (frames > UPLOAD_MAX_FRAMES) throw new UploadValidationError(`That animation has ${frames} frames. Animations can have at most ${UPLOAD_MAX_FRAMES}.`);
    if (frames * dims.width * dims.height > UPLOAD_MAX_ANIMATION_PIXELS) {
      throw new UploadValidationError("That animation is too large to play safely. Use fewer frames or a smaller size.");
    }
  }

  let bytes = raw;
  try {
    if (contentType === "image/png") bytes = stripPngMetadata(raw);
    else if (contentType === "image/jpeg") bytes = stripJpegMetadata(raw);
    else if (contentType === "image/webp") bytes = stripWebpMetadata(raw);
  } catch {
    // A file the strippers can't walk is still checked below by the decoder; keep it as sent.
    bytes = raw;
  }
  return { bytes, contentType, extension: UPLOAD_EXTENSION[contentType], width: dims.width, height: dims.height, frames };
}

// ── Frame counting (animated GIF / WebP) ───────────────────────────────────

/** Number of image frames in a GIF, or null when its blocks can't be walked. */
export function countGifFrames(buf: Buffer): number | null {
  if (buf.length < 13) return null;
  let offset = 13;
  const flags = buf[10]!;
  if (flags & 0x80) offset += 3 * (1 << ((flags & 0x07) + 1));
  const skipSubBlocks = (at: number): number => {
    let p = at;
    while (p < buf.length) {
      const size = buf[p]!;
      p += 1;
      if (size === 0) return p;
      p += size;
    }
    return -1;
  };
  let frames = 0;
  while (offset < buf.length) {
    const block = buf[offset]!;
    if (block === 0x3b) return frames; // trailer
    if (block === 0x21) {
      offset = skipSubBlocks(offset + 2);
    } else if (block === 0x2c) {
      if (offset + 10 > buf.length) return null;
      frames++;
      if (frames > UPLOAD_MAX_FRAMES) return frames;
      const local = buf[offset + 9]!;
      offset += 10;
      if (local & 0x80) offset += 3 * (1 << ((local & 0x07) + 1));
      offset = skipSubBlocks(offset + 1); // LZW minimum code size, then data
    } else {
      return frames > 0 ? frames : null;
    }
    if (offset < 0) return frames > 0 ? frames : null;
  }
  // No trailer: browsers still show what's there.
  return frames > 0 ? frames : null;
}

/** Number of frames in a WebP (ANMF chunks; 1 for a still image), or null when malformed. */
export function countWebpFrames(buf: Buffer): number | null {
  if (buf.length < 20) return null;
  const end = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  let offset = 12;
  let frames = 0;
  while (offset + 8 <= end) {
    const type = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (type === "ANMF") frames++;
    offset += 8 + size + (size % 2);
  }
  return frames || 1;
}

// ── PNG ─────────────────────────────────────────────────────────────────────

/** Text and time chunks: what carries names, software, GPS (eXIf) and comments. */
const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

export function stripPngMetadata(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buf.length) throw new Error("Truncated PNG chunk");
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new Error("PNG without IEND");
  // Anything after IEND (a common place to hide a second file) is dropped too.
  return Buffer.concat(parts);
}

// ── JPEG ────────────────────────────────────────────────────────────────────

/** EXIF orientation (1-8) from an APP1 segment's payload, or null. */
function exifOrientation(payload: Buffer): number | null {
  if (payload.length < 14 || payload.toString("latin1", 0, 6) !== "Exif\0\0") return null;
  const tiff = payload.subarray(6);
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (at: number) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** A minimal APP1 holding only the orientation tag, so a phone photo still shows the right way up. */
function orientationOnlyApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // no next IFD
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * Drops APP1 (EXIF/XMP), APP3-APP13 and APP15 (IPTC, Photoshop, maker notes) and comments.
 * Keeps APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe colour transform), which change
 * how the picture looks. A non-default EXIF orientation is kept as a tiny orientation-only APP1.
 */
export function stripJpegMetadata(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let offset = 2;
  let orientation: number | null = null;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) throw new Error("Bad JPEG marker");
    const marker = buf[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Start of scan: the rest is image data, copied as it is.
    if (marker === 0xda) {
      parts.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    const length = buf.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buf.length) throw new Error("Truncated JPEG segment");
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !(marker === 0xfe || (isApp && marker !== 0xe0 && marker !== 0xe2 && marker !== 0xee));
    if (marker === 0xe1) orientation ??= exifOrientation(buf.subarray(offset + 4, end));
    if (keep) parts.push(buf.subarray(offset, end));
    offset = end;
  }
  if (offset < buf.length) throw new Error("JPEG without image data");
  if (orientation && orientation !== 1) {
    // Right after JFIF when the file starts with it, otherwise straight after the start marker.
    const afterJfif = parts[1]?.[1] === 0xe0 ? 2 : 1;
    parts.splice(afterJfif, 0, orientationOnlyApp1(orientation));
  }
  return Buffer.concat(parts);
}

// ── WebP ────────────────────────────────────────────────────────────────────

/** Drops the EXIF and XMP chunks and clears their VP8X flags. */
export function stripWebpMetadata(buf: Buffer): Buffer {
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const parts: Buffer[] = [];
  let offset = 12;
  let removed = false;
  while (offset + 8 <= riffEnd) {
    const type = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (offset + 8 + size > riffEnd) throw new Error("Truncated WebP chunk");
    if (type === "EXIF" || type === "XMP ") removed = true;
    else parts.push(buf.subarray(offset, Math.min(end, riffEnd)));
    offset = end;
  }
  if (!removed) return buf.subarray(0, riffEnd);
  const body = Buffer.concat(parts);
  const vp8x = body.toString("latin1", 0, 4) === "VP8X" ? body : null;
  if (vp8x) vp8x[8] = vp8x[8]! & ~0x0c; // XMP (0x04) and EXIF (0x08) flags
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}
