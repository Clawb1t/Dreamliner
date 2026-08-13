import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Attachment } from "discord.js";
import type { BotBrandImageKind } from "./store.js";

const AVATAR_SIZE = 512;
/** Discord guild-member banners commonly use a wide banner ratio. */
const BANNER_WIDTH = 680;
const BANNER_HEIGHT = 240;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const ALLOWED_HINTS = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export type NormalizeImageResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; title: string; details: string };

export type NormalizeAvatarResult = NormalizeImageResult;

function looksLikeImage(contentType: string, name?: string | null): boolean {
  return (
    ALLOWED_HINTS.has(contentType) ||
    /\.(png|jpe?g|gif|webp)$/i.test(name ?? "") ||
    contentType.startsWith("image/")
  );
}

function decodeBase64Image(raw: string): Buffer | null {
  const cleaned = raw.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "").trim();
  if (!cleaned) return null;
  try {
    const buf = Buffer.from(cleaned, "base64");
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

async function normalizeToPng(
  raw: Buffer,
  kind: BotBrandImageKind,
): Promise<NormalizeImageResult> {
  if (raw.byteLength > MAX_DOWNLOAD_BYTES) {
    return {
      ok: false,
      title: "File too large",
      details: `Images must be ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB or smaller.`,
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

    const targetW = kind === "banner" ? BANNER_WIDTH : AVATAR_SIZE;
    const targetH = kind === "banner" ? BANNER_HEIGHT : AVATAR_SIZE;

    // Cover-crop to the target aspect, then scale.
    const scale = Math.max(targetW / srcW, targetH / srcH);
    const cropW = targetW / scale;
    const cropH = targetH / scale;
    const sx = Math.max(0, (srcW - cropW) / 2);
    const sy = Math.max(0, (srcH - cropH) / 2);

    const canvas = createCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, sx, sy, cropW, cropH, 0, 0, targetW, targetH);

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

export async function normalizeBrandImageBuffer(
  raw: Buffer,
  kind: BotBrandImageKind,
): Promise<NormalizeImageResult> {
  return normalizeToPng(raw, kind);
}

export async function normalizeBrandImageBase64(
  imageBase64: string,
  kind: BotBrandImageKind,
): Promise<NormalizeImageResult> {
  const raw = decodeBase64Image(imageBase64);
  if (!raw) {
    return {
      ok: false,
      title: "Invalid image",
      details: "Provide a base64-encoded PNG, JPEG, GIF, or WebP image.",
    };
  }
  if (raw.byteLength > MAX_DOWNLOAD_BYTES) {
    return {
      ok: false,
      title: "File too large",
      details: `Images must be ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB or smaller.`,
    };
  }
  return normalizeToPng(raw, kind);
}

/**
 * Download an attachment and re-encode it as a PNG Discord accepts reliably.
 * @deprecated Discord slash upload path; prefer {@link normalizeBrandImageBase64}.
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
  if (!looksLikeImage(contentType, attachment.name)) {
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

  return normalizeToPng(raw, "avatar");
}
