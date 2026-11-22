import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createCanvas } from "@napi-rs/canvas";
import { getDb } from "../../db/client.js";
import { getSiteUrl } from "../docsUrl.js";
import { imageDimensions, loadImageSafe } from "../safeImage.js";
import { getLogger } from "../logger.js";
import { UPLOAD_EXTENSION, UPLOAD_IMAGE_TYPES, UploadValidationError, validateUpload, type UploadImageType } from "./validate.js";

const log = getLogger("serverFiles");

/**
 * Server Files: one image library per server. Every dashboard image upload lands here, and the
 * older per-feature stores are indexed in place:
 *
 *   source        bytes on disk (data/guild-assets/<guildId>/...)      legacy_ref (what configs hold)
 *   upload        files/<id>.<ext>                                     -
 *   message_kits  message-kits/<assetId>   (images only)               asset:<assetId>
 *   welcome       welcome/<assetId>.png    (Welcomer card backgrounds) <assetId>
 *   passport, appeals, team_kiosk, characters
 *                 <folder>/<assetId>.png   (page backgrounds, avatars) <assetId>
 *
 * Nothing is copied, so the old links keep working, and each file also gets a Server Files link.
 * syncLegacyFiles() runs on every listing: new legacy uploads appear straight away and ones their
 * feature pruned drop out. The public link is /api/files/<guildId>/<id>.<ext> on the website,
 * which proxies the bridge; the id is 32 random hex characters and never changes, so replacing a
 * file's bytes updates every place using it.
 */

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "guild-assets");
let root = DEFAULT_ROOT;
let testDb: Database.Database | null = null;

/** Tests point the store at a temp folder and database. */
export function setServerFilesTestEnv(env: { root: string; db: Database.Database } | null): void {
  root = env?.root ?? DEFAULT_ROOT;
  testDb = env?.db ?? null;
}

export function serverFilesDb(): Database.Database {
  return testDb ?? (getDb() as unknown as { session: { client: Database.Database } }).session.client;
}

export const FILE_ID_RE = /^[a-f0-9]{32}$/;
const GUILD_ID_RE = /^\d{15,22}$/;
const STORAGE_RE =
  /^(?:files\/[a-f0-9]{32}\.(?:png|jpg|gif|webp)|message-kits\/[a-f0-9]{16}|(?:welcome|passport|appeals|team_kiosk|characters)\/[a-zA-Z0-9_-]{1,64}\.png)$/;

export const SERVER_FILES_QUOTA = {
  free: { count: 100, bytes: 100 * 1024 * 1024 },
  one: { count: 1000, bytes: 1024 * 1024 * 1024 },
} as const;

export type FileSource = "upload" | "message_kits" | "welcome" | "passport" | "appeals" | "team_kiosk" | "characters";

export type ServerFile = {
  id: string;
  guildId: string;
  displayName: string;
  originalName: string;
  contentType: UploadImageType;
  extension: string;
  size: number;
  width: number;
  height: number;
  frames: number;
  sha256: string;
  folder: string | null;
  storage: string;
  source: FileSource;
  legacyRef: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
};

export class ServerFileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ServerFileError";
  }
}

type Row = Record<string, unknown>;

function fromRow(row: Row): ServerFile {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    displayName: String(row.display_name),
    originalName: String(row.original_name),
    contentType: String(row.content_type) as UploadImageType,
    extension: String(row.extension),
    size: Number(row.size),
    width: Number(row.width),
    height: Number(row.height),
    frames: Number(row.frames ?? 1),
    sha256: String(row.sha256),
    folder: (row.folder as string | null) ?? null,
    storage: String(row.storage),
    source: String(row.source) as FileSource,
    legacyRef: (row.legacy_ref as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
  };
}

function guildDir(guildId: string): string {
  if (!GUILD_ID_RE.test(guildId)) throw new ServerFileError("Invalid server id");
  return join(root, guildId);
}

/** Absolute path of a file's bytes, only for storage paths of the known shapes (no traversal). */
function bytesPath(guildId: string, storage: string): string {
  if (!STORAGE_RE.test(storage)) throw new ServerFileError("Invalid storage path");
  return join(guildDir(guildId), ...storage.split("/"));
}

/** The public link Discord and browsers load. Follows the site origin (DREAMLINER_ENV). */
export function serverFileUrl(file: Pick<ServerFile, "guildId" | "id" | "extension">): string {
  return `${getSiteUrl().replace(/\/$/, "")}/api/files/${file.guildId}/${file.id}.${file.extension}`;
}

/** `https://site/api/files/<guild>/<id>.<ext>` → its parts, for any site origin. */
export function parseServerFileUrl(url: string): { guildId: string; id: string; extension: string } | null {
  const match = /\/api\/files\/(\d{15,22})\/([a-f0-9]{32})\.(png|jpg|gif|webp)(?:[?#].*)?$/.exec(url.trim());
  return match ? { guildId: match[1]!, id: match[2]!, extension: match[3]! } : null;
}

function cleanName(raw: string, extension: string): string {
  const base = (raw || "image")
    .normalize("NFKC")
    .split(/[/\\]/)
    .pop()!
    .replace(/\.[^.]*$/, "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "image"}.${extension}`;
}

export function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return name || null;
}

export function cleanFolder(raw: unknown): string | null | undefined {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const name = raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return name || null;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function getServerFile(guildId: string, id: string): ServerFile | null {
  if (!GUILD_ID_RE.test(guildId) || !FILE_ID_RE.test(id)) return null;
  const row = serverFilesDb().prepare("SELECT * FROM server_files WHERE guild_id = ? AND id = ?").get(guildId, id) as Row | undefined;
  return row ? fromRow(row) : null;
}

function rows(guildId: string): ServerFile[] {
  return (serverFilesDb().prepare("SELECT * FROM server_files WHERE guild_id = ? ORDER BY created_at DESC").all(guildId) as Row[]).map(fromRow);
}

/** Newest first, after picking up new or removed files from the older per-feature stores. */
export function listServerFiles(guildId: string): ServerFile[] {
  guildDir(guildId);
  syncLegacyFiles(guildId);
  return rows(guildId);
}

export function serverFilesUsage(guildId: string): { count: number; bytes: number } {
  const row = serverFilesDb().prepare("SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM server_files WHERE guild_id = ?").get(guildId) as { n: number; b: number };
  return { count: Number(row.n), bytes: Number(row.b) };
}

/** The bytes of one file, only when the id belongs to this server and the link's extension matches. */
export function readServerFile(guildId: string, id: string, extension: string): { file: ServerFile; bytes: Buffer } | null {
  const file = getServerFile(guildId, id);
  if (!file || file.extension !== extension.toLowerCase()) return null;
  try {
    return { file, bytes: readFileSync(bytesPath(guildId, file.storage)) };
  } catch {
    return null;
  }
}

/**
 * Bytes for a Server Files link if it points at this machine's store (the bot reads its own files
 * from disk instead of fetching them over the internet, which also works in local dev).
 */
export function readServerFileByUrl(url: string): Buffer | null {
  const parts = parseServerFileUrl(url);
  if (!parts) return null;
  const site = getSiteUrl().replace(/\/$/, "");
  if (!url.trim().startsWith(`${site}/api/files/`)) return null;
  return readServerFile(parts.guildId, parts.id, parts.extension)?.bytes ?? null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

export type SaveOptions = {
  quota?: { count: number; bytes: number };
  folder?: string | null;
  /** Throws when the image matches the scam-image blocklist. Defaults to the automod blocklist. */
  contentCheck?: (bytes: Buffer) => Promise<void>;
};

/** The shared scam-image blocklist (automod Image Scanning), run on every upload. */
export async function defaultContentCheck(bytes: Buffer): Promise<void> {
  let match: { distance: number } | null = null;
  try {
    const [{ computeDHash }, { closestScamImageHash }] = await Promise.all([
      import("../../plugins/automod/functions/imageHash.js"),
      import("../../plugins/automod/functions/scamImageHashes.js"),
    ]);
    match = await closestScamImageHash(await computeDHash(bytes));
  } catch (error) {
    // The blocklist being unreachable shouldn't stop uploads; the image was still decoded safely.
    log.warn("Server Files: scam image check skipped:", error);
    return;
  }
  if (match && match.distance <= 5) {
    throw new UploadValidationError("That image matches a known scam image, so it can't be uploaded.", 422);
  }
}

async function checkedImage(raw: Buffer, contentCheck: (bytes: Buffer) => Promise<void>) {
  const valid = validateUpload(raw);
  // Headers can be faked; decoding (dimension-checked first, see safeImage) can't.
  try {
    await loadImageSafe(valid.bytes);
  } catch {
    throw new UploadValidationError("That image couldn't be read. It may be damaged.");
  }
  await contentCheck(valid.bytes);
  return valid;
}

function writeAtomic(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
}

/** Validates and stores an upload. The same image uploaded twice returns the existing file. */
export async function saveServerFile(
  guildId: string,
  userId: string,
  input: { filename: string; bytes: Buffer },
  options: SaveOptions = {},
): Promise<{ file: ServerFile; existing: boolean }> {
  guildDir(guildId);
  const valid = await checkedImage(input.bytes, options.contentCheck ?? defaultContentCheck);
  const sha256 = createHash("sha256").update(valid.bytes).digest("hex");

  const same = (serverFilesDb().prepare("SELECT * FROM server_files WHERE guild_id = ? AND sha256 = ?").all(guildId, sha256) as Row[])
    .map(fromRow)
    .find((f) => existsSync(bytesPath(guildId, f.storage)));
  if (same) {
    touchServerFile(guildId, same.id);
    return { file: { ...same, lastUsedAt: Date.now() }, existing: true };
  }

  const quota = options.quota ?? SERVER_FILES_QUOTA.free;
  const usage = serverFilesUsage(guildId);
  if (usage.count >= quota.count) {
    throw new ServerFileError(`This server has ${quota.count} files, the most it can keep. Delete some you no longer use first.`, 409);
  }
  if (usage.bytes + valid.bytes.length > quota.bytes) {
    throw new ServerFileError(`This server's files would go over ${Math.round(quota.bytes / 1024 / 1024)} MB. Delete some you no longer use first.`, 409);
  }

  const id = randomBytes(16).toString("hex");
  const storage = `files/${id}.${valid.extension}`;
  const path = bytesPath(guildId, storage);
  writeAtomic(path, valid.bytes);
  const now = Date.now();
  const name = cleanName(input.filename, valid.extension);
  const file: ServerFile = {
    id,
    guildId,
    displayName: name,
    originalName: name,
    contentType: valid.contentType,
    extension: valid.extension,
    size: valid.bytes.length,
    width: valid.width,
    height: valid.height,
    frames: valid.frames,
    sha256,
    folder: options.folder ?? null,
    storage,
    source: "upload",
    legacyRef: null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  };
  try {
    insertRow(file);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return { file, existing: false };
}

function insertRow(file: ServerFile): void {
  serverFilesDb()
    .prepare(
      `INSERT INTO server_files (id, guild_id, display_name, original_name, content_type, extension, size, width, height, frames, sha256,
         folder, storage, source, legacy_ref, created_by, created_at, updated_at, last_used_at)
       VALUES (@id, @guildId, @displayName, @originalName, @contentType, @extension, @size, @width, @height, @frames, @sha256,
         @folder, @storage, @source, @legacyRef, @createdBy, @createdAt, @updatedAt, @lastUsedAt)`,
    )
    .run(file);
}

/** Re-encodes to PNG (the older stores' files are always PNGs their features read by name). */
async function toPng(bytes: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  const image = await loadImageSafe(bytes);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return { png: canvas.toBuffer("image/png"), width: image.width, height: image.height };
}

/**
 * Replaces a file's bytes and keeps its id and link, so every place using it shows the new image.
 * Files of the older stores keep the format their feature reads (PNG; Message Kits keep the type).
 */
export async function replaceServerFile(
  guildId: string,
  id: string,
  userId: string,
  raw: Buffer,
  options: Pick<SaveOptions, "quota" | "contentCheck"> = {},
): Promise<ServerFile> {
  const file = getServerFile(guildId, id);
  if (!file) throw new ServerFileError("That file doesn't exist anymore.", 404);
  const valid = await checkedImage(raw, options.contentCheck ?? defaultContentCheck);

  let bytes = valid.bytes;
  let contentType: UploadImageType = valid.contentType;
  let width = valid.width;
  let height = valid.height;
  let frames = valid.frames;
  if (file.source !== "upload" && file.source !== "message_kits") {
    const png = await toPng(valid.bytes);
    bytes = png.png;
    contentType = "image/png";
    width = png.width;
    height = png.height;
    frames = 1;
  }

  const quota = options.quota ?? SERVER_FILES_QUOTA.free;
  if (serverFilesUsage(guildId).bytes - file.size + bytes.length > quota.bytes) {
    throw new ServerFileError(`This server's files would go over ${Math.round(quota.bytes / 1024 / 1024)} MB.`, 409);
  }

  // Same storage path and link extension: the link never changes. The served Content-Type follows
  // the real bytes, which is what browsers and Discord go by.
  writeAtomic(bytesPath(guildId, file.storage), bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const now = Date.now();
  serverFilesDb()
    .prepare(
      `UPDATE server_files SET content_type = ?, size = ?, width = ?, height = ?, frames = ?, sha256 = ?,
         updated_at = ?, created_by = coalesce(created_by, ?) WHERE guild_id = ? AND id = ?`,
    )
    .run(contentType, bytes.length, width, height, frames, sha256, now, userId, guildId, id);
  if (file.source === "message_kits") {
    try {
      serverFilesDb()
        .prepare("UPDATE message_kit_assets SET content_type = ?, size = ?, sha256 = ? WHERE guild_id = ? AND id = ?")
        .run(contentType, bytes.length, sha256, guildId, file.storage.slice("message-kits/".length));
    } catch {
      // No Message Kits table in this build.
    }
  }
  return getServerFile(guildId, id)!;
}

export function updateServerFile(guildId: string, id: string, patch: { displayName?: string; folder?: string | null }): ServerFile | null {
  const file = getServerFile(guildId, id);
  if (!file) return null;
  const displayName = patch.displayName ?? file.displayName;
  const folder = patch.folder === undefined ? file.folder : patch.folder;
  serverFilesDb().prepare("UPDATE server_files SET display_name = ?, folder = ?, updated_at = ? WHERE guild_id = ? AND id = ?").run(displayName, folder, Date.now(), guildId, id);
  return getServerFile(guildId, id);
}

export function touchServerFile(guildId: string, id: string): boolean {
  return serverFilesDb().prepare("UPDATE server_files SET last_used_at = ? WHERE guild_id = ? AND id = ?").run(Date.now(), guildId, id).changes > 0;
}

/** Deletes the file and its bytes (for older stores, also their own record so they stay consistent). */
export function deleteServerFile(guildId: string, id: string): boolean {
  const file = getServerFile(guildId, id);
  if (!file) return false;
  try {
    rmSync(bytesPath(guildId, file.storage), { force: true });
  } catch {
    // The row is what matters; a stray file is harmless.
  }
  if (file.source === "message_kits") {
    try {
      serverFilesDb().prepare("DELETE FROM message_kit_assets WHERE guild_id = ? AND id = ?").run(guildId, file.storage.slice("message-kits/".length));
    } catch {
      // No Message Kits table in this build.
    }
  }
  return serverFilesDb().prepare("DELETE FROM server_files WHERE guild_id = ? AND id = ?").run(guildId, id).changes > 0;
}

// ── The older per-feature stores, indexed in place ─────────────────────────

const LEGACY_FOLDERS: { folder: string; source: FileSource; label: string }[] = [
  { folder: "welcome", source: "welcome", label: "Welcomer card background" },
  { folder: "passport", source: "passport", label: "Passport page background" },
  { folder: "appeals", source: "appeals", label: "Appeals page background" },
  { folder: "team_kiosk", source: "team_kiosk", label: "Team Control kiosk background" },
  { folder: "characters", source: "characters", label: "Character avatar" },
];

function indexLegacy(
  guildId: string,
  entry: { storage: string; source: FileSource; legacyRef: string; name: string; createdBy: string | null; createdAt: number; contentType?: string },
): void {
  const path = bytesPath(guildId, entry.storage);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return;
  }
  const dims = imageDimensions(bytes);
  const type = (entry.contentType ?? (dims ? `image/${dims.format}` : "")) as UploadImageType;
  if (!dims || !(UPLOAD_IMAGE_TYPES as readonly string[]).includes(type)) return;
  const extension = UPLOAD_EXTENSION[type];
  try {
    insertRow({
      id: randomBytes(16).toString("hex"),
      guildId,
      displayName: entry.name,
      originalName: entry.name,
      contentType: type,
      extension,
      size: bytes.length,
      width: dims.width,
      height: dims.height,
      frames: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      folder: null,
      storage: entry.storage,
      source: entry.source,
      legacyRef: entry.legacyRef,
      createdBy: entry.createdBy,
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      lastUsedAt: null,
    });
  } catch {
    // Already indexed (unique guild + storage).
  }
}

/**
 * Indexes files the older stores hold that aren't in Server Files yet, and drops rows whose bytes
 * their feature removed. Idempotent and cheap (a directory listing per folder, one query).
 */
export function syncLegacyFiles(guildId: string): void {
  const dir = guildDir(guildId);
  const known = new Map(rows(guildId).map((f) => [f.storage, f]));

  for (const { folder, source, label } of LEGACY_FOLDERS) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      const storage = `${folder}/${name}`;
      if (known.has(storage) || !STORAGE_RE.test(storage)) continue;
      let createdAt = Date.now();
      try {
        createdAt = Math.round(statSync(join(dir, folder, name)).mtimeMs);
      } catch {
        continue;
      }
      indexLegacy(guildId, { storage, source, legacyRef: name.slice(0, -4), name: `${label}.png`, createdBy: null, createdAt });
    }
  }

  try {
    const kitAssets = serverFilesDb()
      .prepare("SELECT id, filename, content_type, created_by, created_at FROM message_kit_assets WHERE guild_id = ?")
      .all(guildId) as { id: string; filename: string; content_type: string; created_by: string | null; created_at: number }[];
    for (const asset of kitAssets) {
      const storage = `message-kits/${asset.id}`;
      if (known.has(storage) || !(UPLOAD_IMAGE_TYPES as readonly string[]).includes(asset.content_type) || !STORAGE_RE.test(storage)) continue;
      indexLegacy(guildId, {
        storage,
        source: "message_kits",
        legacyRef: `asset:${asset.id}`,
        name: asset.filename,
        createdBy: asset.created_by,
        createdAt: Number(asset.created_at),
        contentType: asset.content_type,
      });
    }
  } catch {
    // No Message Kits table in this build.
  }

  // Files their own feature deleted or pruned.
  for (const file of known.values()) {
    if (file.source === "upload") continue;
    if (!existsSync(bytesPath(guildId, file.storage))) {
      serverFilesDb().prepare("DELETE FROM server_files WHERE guild_id = ? AND id = ?").run(guildId, file.id);
    }
  }
}
