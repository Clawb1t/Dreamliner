import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Attachment } from "discord.js";

/** Discord is happiest with square PNGs around this size for guild avatars. */
const TARGET_SIZE = 512;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const ALLOWED_HINTS = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export type NormalizeAvatarResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; title: string; details: string };

/**
 * Download an attachment and re-encode it as a square PNG Discord accepts reliably.
 * Center-crops to square, scales to {@link TARGET_SIZE}, outputs `image/png`.
 */
export async function normalizeAvatarAttachment(attachment: Attachment): Promise<NormalizeAvatarResult> {
  if (attachment.size > MAX_DOWNLOAD_BYTES) {
    return {
      ok: false,
      title: "File too large",
      details: `Avatar images must be ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB or smaller.`,
    };
  }

  const contentType = (attachment.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const looksLikeImage =
    ALLOWED_HINTS.has(contentType) ||
    /\.(png|jpe?g|gif|webp)$/i.test(attachment.name ?? "") ||
    contentType.startsWith("image/");

  if (!looksLikeImage) {
    return {
      ok: false,
      title: "Invalid image",
      details: "Upload a PNG, JPEG, GIF, or WebP image.",
    };
  }

  let raw: Buffer;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      return {
        ok: false,
        title: "Download failed",
        details: "Could not download that attachment. Try again.",
      };
    }
    raw = Buffer.from(await res.arrayBuffer());
  } catch {
    return {
      ok: false,
      title: "Download failed",
      details: "Could not download that attachment. Try again.",
    };
  }

  if (raw.byteLength > MAX_DOWNLOAD_BYTES) {
    return {
      ok: false,
      title: "File too large",
      details: `Avatar images must be ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB or smaller.`,
    };
  }

  try {
    const image = await loadImage(raw);
    const srcW = image.width;
    const srcH = image.height;
    if (!srcW || !srcH) {
      return {
        ok: false,
        title: "Invalid image",
        details: "That file could not be read as an image.",
      };
    }

    // Center-crop to a square, then scale to TARGET_SIZE.
    const side = Math.min(srcW, srcH);
    const sx = Math.floor((srcW - side) / 2);
    const sy = Math.floor((srcH - side) / 2);

    const canvas = createCanvas(TARGET_SIZE, TARGET_SIZE);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, sx, sy, side, side, 0, 0, TARGET_SIZE, TARGET_SIZE);

    const buffer = canvas.toBuffer("image/png");
    if (buffer.byteLength > MAX_OUTPUT_BYTES) {
      return {
        ok: false,
        title: "Image too large",
        details: "Even after converting to PNG, the image is too large for Discord. Try a simpler image.",
      };
    }

    return { ok: true, buffer };
  } catch {
    return {
      ok: false,
      title: "Could not process image",
      details: "Dreamliner could not convert that file. Try a different PNG or JPEG.",
    };
  }
}
