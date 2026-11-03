import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_LIMITS } from "./constants.js";
import { ASSET_ID_RE } from "./document.js";
import { assetUsage, deleteAssetRow, getAsset, insertAsset, listAssets, type KitAssetRecord } from "./store.js";

/**
 * Uploaded images and files for Message Kits. Same storage convention as the welcomer, evidence
 * and clip uploads: bytes on disk under data/guild-assets/<guildId>/<folder>/, metadata in the
 * database. Images are checked by their bytes (not the claimed type); other files are kept as-is
 * and only ever sent back to Discord as attachments.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ASSETS_ROOT = join(ROOT, "data", "guild-assets");

export class KitAssetError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function assetDir(guildId: string): string {
  if (!/^\d{15,25}$/.test(guildId)) throw new KitAssetError("Invalid server id");
  return join(ASSETS_ROOT, guildId, "message-kits");
}

function assetPath(guildId: string, assetId: string): string {
  if (!ASSET_ID_RE.test(assetId)) throw new KitAssetError("Invalid asset id");
  return join(assetDir(guildId), assetId);
}

/** The real image type from the file's first bytes, or null when it isn't png/jpeg/gif/webp. */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  return null;
}

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** A file name Discord and every OS accept: letters, digits, dot, dash, underscore; at most 80. */
export function safeFilename(raw: string, contentType: string): string {
  const cleaned = (raw || "file")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-80);
  let name = cleaned || "file";
  const ext = EXTENSION[contentType];
  if (ext && !new RegExp(`\\.${ext === "jpg" ? "jpe?g" : ext}$`, "i").test(name)) name = `${name.replace(/\.[^.]*$/, "")}.${ext}`;
  return name.slice(-80);
}

export function isImageAsset(asset: Pick<KitAssetRecord, "contentType">): boolean {
  return (KIT_LIMITS.assetImageTypes as readonly string[]).includes(asset.contentType);
}

export function readKitAsset(guildId: string, assetId: string): Buffer | null {
  try {
    const path = assetPath(guildId, assetId);
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

export function listKitAssets(guildId: string): KitAssetRecord[] {
  return listAssets(guildId);
}

/** Stores an upload. The same bytes uploaded twice return the existing asset. */
export function saveKitAsset(
  guildId: string,
  userId: string,
  input: { filename: string; contentType: string; bytes: Buffer },
): KitAssetRecord {
  const { bytes } = input;
  if (!bytes.length) throw new KitAssetError("That file is empty.");
  if (bytes.length > KIT_LIMITS.assetBytes) throw new KitAssetError(`Files can be at most ${KIT_LIMITS.assetBytes / 1024 / 1024} MB.`, 413);

  const claimed = (input.contentType || "").toLowerCase().split(";")[0]!.trim();
  const sniffed = sniffImageType(bytes);
  let contentType: string;
  if (claimed.startsWith("image/") && (KIT_LIMITS.assetImageTypes as readonly string[]).includes(claimed)) {
    if (!sniffed) throw new KitAssetError("That image couldn't be read. Upload a PNG, JPEG, GIF or WebP.");
    contentType = sniffed;
  } else if (sniffed) {
    contentType = sniffed;
  } else {
    // Any other file is stored as an opaque attachment.
    contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(claimed) && !claimed.startsWith("image/") ? claimed : "application/octet-stream";
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = listAssets(guildId).find((asset) => asset.sha256 === sha256);
  if (existing && readKitAsset(guildId, existing.id)) return existing;

  const usage = assetUsage(guildId);
  if (usage.count >= KIT_LIMITS.assets) throw new KitAssetError(`A server can keep ${KIT_LIMITS.assets} uploads. Delete some you no longer use first.`, 409);
  if (usage.bytes + bytes.length > KIT_LIMITS.assetTotalBytes)
    throw new KitAssetError(`A server can keep ${KIT_LIMITS.assetTotalBytes / 1024 / 1024} MB of uploads. Delete some you no longer use first.`, 409);

  const id = randomBytes(8).toString("hex");
  mkdirSync(assetDir(guildId), { recursive: true });
  writeFileSync(assetPath(guildId, id), bytes);
  try {
    return insertAsset({
      id,
      guildId,
      filename: safeFilename(input.filename, contentType),
      contentType,
      size: bytes.length,
      sha256,
      createdBy: userId,
      createdAt: new Date(),
    });
  } catch (error) {
    rmSync(assetPath(guildId, id), { force: true });
    throw error;
  }
}

export function deleteKitAsset(guildId: string, assetId: string): boolean {
  if (!ASSET_ID_RE.test(assetId) || !getAsset(guildId, assetId)) return false;
  try {
    const path = assetPath(guildId, assetId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // The row is what matters; a stray file is harmless.
  }
  return deleteAssetRow(guildId, assetId);
}
