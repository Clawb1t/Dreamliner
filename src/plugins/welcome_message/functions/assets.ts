import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ASSETS_ROOT = join(ROOT, "data", "guild-assets");

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DIMENSION = 2000;

export function welcomeAssetDir(guildId: string): string {
  return join(ASSETS_ROOT, guildId, "welcome");
}

export function welcomeAssetPath(guildId: string, assetId: string): string {
  const safeId = assetId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId || safeId !== assetId) {
    throw new Error("Invalid asset id");
  }
  return join(welcomeAssetDir(guildId), `${safeId}.png`);
}

export function readWelcomeAsset(guildId: string, assetId: string): Buffer | null {
  try {
    const path = welcomeAssetPath(guildId, assetId);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function deleteWelcomeAsset(guildId: string, assetId: string): boolean {
  try {
    const path = welcomeAssetPath(guildId, assetId);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Normalize an uploaded image into a PNG and store it for the guild. */
export async function saveWelcomeBackgroundAsset(
  guildId: string,
  raw: Buffer,
): Promise<{ assetId: string; bytes: number }> {
  if (!raw.length) throw new Error("Empty upload");
  if (raw.length > MAX_UPLOAD_BYTES) throw new Error("Image must be 4MB or smaller");

  const image = await loadImage(raw);
  const width = Math.min(MAX_DIMENSION, Math.max(1, image.width));
  const height = Math.min(MAX_DIMENSION, Math.max(1, image.height));
  const scale = Math.min(width / image.width, height / image.height, 1);
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, w, h);
  const png = canvas.toBuffer("image/png");

  const hash = createHash("sha1").update(png).digest("hex").slice(0, 10);
  const assetId = `${hash}${randomBytes(3).toString("hex")}`;
  const dir = welcomeAssetDir(guildId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(welcomeAssetPath(guildId, assetId), png);
  return { assetId, bytes: png.length };
}
