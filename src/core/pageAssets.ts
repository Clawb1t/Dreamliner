import { loadImageSafe } from "./safeImage.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

/**
 * Images a server uploads for its public pages (Passport, Appeals backgrounds), stored under
 * data/guild-assets/<guildId>/<folder>/<assetId>.png. Every upload is decoded and re-encoded
 * as a PNG, so whatever reaches disk (and later a browser) is a plain image, never the raw bytes
 * someone sent.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ASSETS_ROOT = join(ROOT, "data", "guild-assets");

export const MAX_PAGE_ASSET_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DIMENSION = 2000;
/** Oldest uploads beyond this are deleted, so repeated uploads can't fill the disk. */
const MAX_ASSETS_PER_FOLDER = 10;

export type PageAssetFolder = "passport" | "appeals" | "characters";

/** Folders that hold one image per item (each character's avatar) keep more than a page's few. */
const FOLDER_LIMITS: Partial<Record<PageAssetFolder, number>> = { characters: 80 };

const ASSET_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function isPageAssetId(value: string): boolean {
  return ASSET_ID.test(value);
}

function folderDir(guildId: string, folder: PageAssetFolder): string {
  if (!/^\d{15,22}$/.test(guildId)) throw new Error("Invalid guild id");
  return join(ASSETS_ROOT, guildId, folder);
}

export function pageAssetPath(guildId: string, folder: PageAssetFolder, assetId: string): string {
  if (!isPageAssetId(assetId)) throw new Error("Invalid asset id");
  return join(folderDir(guildId, folder), `${assetId}.png`);
}

export function readPageAsset(guildId: string, folder: PageAssetFolder, assetId: string): Buffer | null {
  try {
    const path = pageAssetPath(guildId, folder, assetId);
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

export function deletePageAsset(guildId: string, folder: PageAssetFolder, assetId: string): boolean {
  try {
    const path = pageAssetPath(guildId, folder, assetId);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function pruneFolder(dir: string, keep: string, max = MAX_ASSETS_PER_FOLDER): void {
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".png"))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const file of files.slice(max)) {
      if (file.name !== `${keep}.png`) unlinkSync(join(dir, file.name));
    }
  } catch {
    // Best effort.
  }
}

/** Decode, downscale to at most 2000px, re-encode as PNG, and store. */
export async function savePageAsset(
  guildId: string,
  folder: PageAssetFolder,
  raw: Buffer,
): Promise<{ assetId: string; bytes: number }> {
  if (!raw.length) throw new Error("Empty upload");
  if (raw.length > MAX_PAGE_ASSET_UPLOAD_BYTES) throw new Error("Image must be 4MB or smaller");

  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImageSafe(raw);
  } catch {
    throw new Error("That file isn't an image we can read. Use PNG, JPEG or WebP.");
  }
  const scale = Math.min(MAX_DIMENSION / image.width, MAX_DIMENSION / image.height, 1);
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(image, 0, 0, w, h);
  const png = canvas.toBuffer("image/png");

  const hash = createHash("sha1").update(png).digest("hex").slice(0, 10);
  const assetId = `${hash}${randomBytes(3).toString("hex")}`;
  const dir = folderDir(guildId, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pageAssetPath(guildId, folder, assetId), png);
  pruneFolder(dir, assetId, FOLDER_LIMITS[folder]);
  return { assetId, bytes: png.length };
}

/** A base64 upload from the dashboard (optionally a data: URL). */
export function decodeBase64Upload(base64: string): Buffer {
  const cleaned = base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
  // Reject before decoding anything far over the limit (base64 is ~4/3 the raw size).
  if (cleaned.length > Math.ceil((MAX_PAGE_ASSET_UPLOAD_BYTES * 4) / 3) + 16) {
    throw new Error("Image must be 4MB or smaller");
  }
  return Buffer.from(cleaned, "base64");
}
