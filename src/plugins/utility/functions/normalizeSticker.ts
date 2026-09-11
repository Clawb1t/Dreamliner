import { createCanvas, loadImage } from "@napi-rs/canvas";

/** Discord's own limits for a guild sticker file. */
const MAX_STICKER_BYTES = 512_000;
const TARGET_SIZE = 320;
/** Progressively shrink the canvas until the PNG fits, rather than fail outright. */
const FALLBACK_SIZES = [TARGET_SIZE, 256, 200, 160, 128];

export type NormalizeStickerResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; title: string; details: string };

/**
 * Re-encodes an arbitrary image as a square PNG sized and compressed to fit Discord's
 * sticker limits (320x320, 512KB). Cover-crops to square first so non-square source
 * images (most message attachments) don't get squashed.
 */
export async function normalizeSticker(raw: Buffer): Promise<NormalizeStickerResult> {
  let image;
  try {
    image = await loadImage(raw);
  } catch {
    return {
      ok: false,
      title: "Invalid image",
      details: "That file could not be read as an image.",
    };
  }

  const srcW = image.width;
  const srcH = image.height;
  if (!srcW || !srcH) {
    return {
      ok: false,
      title: "Invalid image",
      details: "That file could not be read as an image.",
    };
  }

  const cropSize = Math.min(srcW, srcH);
  const sx = (srcW - cropSize) / 2;
  const sy = (srcH - cropSize) / 2;

  for (const size of FALLBACK_SIZES) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, sx, sy, cropSize, cropSize, 0, 0, size, size);

    const buffer = canvas.toBuffer("image/png");
    if (buffer.byteLength <= MAX_STICKER_BYTES) {
      return { ok: true, buffer };
    }
  }

  return {
    ok: false,
    title: "Image too large",
    details: "Even shrunk down, that image is too complex to fit Discord's 512KB sticker limit. Try a simpler image.",
  };
}
