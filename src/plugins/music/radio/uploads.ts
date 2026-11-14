import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { radioUploads } from "../../../db/schema.js";
import { GLOBAL_ASSET_KEY, savePageAsset } from "../../../core/pageAssets.js";
import { getLogger } from "../../../core/logger.js";
import {
  RADIO_LIMITS,
  RADIO_TMP,
  fileSize,
  insertTrack,
  listTracks,
  newRadioId,
  radioStorageLimitBytes,
  stationDir,
  totalStorageBytes,
  trackFilePath,
  type RadioTrackRow,
} from "./store.js";

/**
 * MP3 uploads arrive in base64 chunks (the website runs on Vercel, which refuses request bodies
 * over 4.5MB): init -> chunk 0..n in order -> complete. Chunks are appended to a temp file; on
 * complete the file is checked, its tags read, and it's moved into the station.
 */

const log = getLogger("music");

export const RADIO_CHUNK_BYTES = 3 * 1024 * 1024;
export const RADIO_MAX_FILE_BYTES = 100 * 1024 * 1024;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

export class RadioUploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function tmpPath(uploadId: string): string {
  if (!/^[a-f0-9]{24}$/.test(uploadId)) throw new RadioUploadError("Unknown upload.", 404);
  return join(RADIO_TMP, `${uploadId}.part`);
}

export async function startUpload(stationId: string, filename: string, sizeBytes: number, actorId: string): Promise<{ uploadId: string; chunkBytes: number }> {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new RadioUploadError("That file is empty.");
  if (sizeBytes > RADIO_MAX_FILE_BYTES) throw new RadioUploadError("MP3s can be up to 100MB each.");
  if (!/\.mp3$/i.test(filename)) throw new RadioUploadError("Only .mp3 files can be uploaded.");
  if ((await listTracks(stationId)).length >= RADIO_LIMITS.tracksPerStation) {
    throw new RadioUploadError(`A station can have up to ${RADIO_LIMITS.tracksPerStation} tracks.`);
  }
  if ((await totalStorageBytes()) + sizeBytes > radioStorageLimitBytes()) {
    throw new RadioUploadError("Radio storage is full. Delete some tracks first.", 413);
  }
  const uploadId = randomBytes(12).toString("hex");
  mkdirSync(RADIO_TMP, { recursive: true });
  await getDb()
    .insert(radioUploads)
    .values({
      id: uploadId,
      stationId,
      filename: filename.slice(0, 200),
      expectedBytes: sizeBytes,
      createdBy: actorId,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    });
  return { uploadId, chunkBytes: RADIO_CHUNK_BYTES };
}

async function getUpload(stationId: string, uploadId: string) {
  const row = await getDb()
    .select()
    .from(radioUploads)
    .where(and(eq(radioUploads.id, uploadId), eq(radioUploads.stationId, stationId)))
    .get();
  if (!row || row.expiresAt.getTime() < Date.now()) throw new RadioUploadError("That upload expired. Start it again.", 404);
  return row;
}

export async function appendChunk(stationId: string, uploadId: string, index: number, dataBase64: string): Promise<{ receivedBytes: number }> {
  const row = await getUpload(stationId, uploadId);
  if (index !== row.nextIndex) throw new RadioUploadError(`Expected chunk ${row.nextIndex}, got ${index}.`, 409);
  if (dataBase64.length > Math.ceil((RADIO_CHUNK_BYTES * 4) / 3) + 16) throw new RadioUploadError("That chunk is too big.", 413);
  const data = Buffer.from(dataBase64, "base64");
  if (!data.length) throw new RadioUploadError("That chunk is empty.");
  const receivedBytes = row.receivedBytes + data.length;
  if (receivedBytes > row.expectedBytes) throw new RadioUploadError("More data was sent than the file size.");
  appendFileSync(tmpPath(uploadId), data);
  await getDb()
    .update(radioUploads)
    .set({ receivedBytes, nextIndex: index + 1 })
    .where(eq(radioUploads.id, uploadId));
  return { receivedBytes };
}

/** MPEG audio starts with an ID3 tag or a frame sync (11 set bits). */
export function looksLikeMp3(head: Buffer): boolean {
  if (head.length >= 3 && head.toString("latin1", 0, 3) === "ID3") return true;
  return head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0;
}

function readHead(path: string, bytes = 16): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function cleanName(filename: string): string {
  return filename.replace(/\.mp3$/i, "").replace(/[_]+/g, " ").trim().slice(0, RADIO_LIMITS.title) || "Untitled";
}

export async function completeUpload(
  stationId: string,
  uploadId: string,
  actorId: string,
): Promise<{ track: RadioTrackRow; duplicate: boolean }> {
  const row = await getUpload(stationId, uploadId);
  const temp = tmpPath(uploadId);
  const finish = async () => {
    await getDb().delete(radioUploads).where(eq(radioUploads.id, uploadId));
    if (existsSync(temp)) unlinkSync(temp);
  };
  try {
    if (row.receivedBytes !== row.expectedBytes || fileSize(temp) !== row.expectedBytes) {
      throw new RadioUploadError("The upload is incomplete. Try again.");
    }
    if (!looksLikeMp3(readHead(temp))) throw new RadioUploadError("That file isn't an MP3.");

    const { parseFile } = await import("music-metadata");
    const meta = await parseFile(temp, { duration: true, skipCovers: false }).catch(() => null);
    const durationMs = Math.round((meta?.format.duration ?? 0) * 1000);
    const codec = `${meta?.format.container ?? ""} ${meta?.format.codec ?? ""}`;
    if (!meta || durationMs < 1000 || !/mpeg|mp3/i.test(codec)) {
      throw new RadioUploadError("That file couldn't be read as MP3 audio.");
    }

    const sha256 = await sha256File(temp);
    const existing = (await listTracks(stationId)).find((t) => t.sha256 === sha256);
    if (existing) {
      await finish();
      return { track: existing, duplicate: true };
    }

    let artworkAssetId: string | null = null;
    const picture = meta.common.picture?.[0];
    if (picture?.data?.length) {
      artworkAssetId = await savePageAsset(GLOBAL_ASSET_KEY, "radio", Buffer.from(picture.data))
        .then((saved) => saved.assetId)
        .catch(() => null);
    }

    const trackId = newRadioId();
    mkdirSync(stationDir(stationId), { recursive: true });
    renameSync(temp, trackFilePath(stationId, trackId));
    const position = (await listTracks(stationId)).reduce((max, t) => Math.max(max, t.position + 1), 0);
    const track: RadioTrackRow = {
      id: trackId,
      stationId,
      position,
      title: (meta.common.title?.trim() || cleanName(row.filename)).slice(0, RADIO_LIMITS.title),
      artist: meta.common.artist?.trim().slice(0, RADIO_LIMITS.artist) || null,
      durationMs,
      sizeBytes: row.expectedBytes,
      sha256,
      artworkAssetId,
      createdBy: actorId,
      createdAt: new Date(),
    };
    await insertTrack(track);
    await finish();
    return { track, duplicate: false };
  } catch (error) {
    await finish().catch(() => {});
    if (error instanceof RadioUploadError) throw error;
    log.error(`Radio upload ${uploadId} failed:`, error);
    throw new RadioUploadError("Couldn't save that file.", 500);
  }
}

export async function abortUpload(stationId: string, uploadId: string): Promise<void> {
  await getDb()
    .delete(radioUploads)
    .where(and(eq(radioUploads.id, uploadId), eq(radioUploads.stationId, stationId)));
  try {
    const temp = tmpPath(uploadId);
    if (existsSync(temp)) unlinkSync(temp);
  } catch {
    // Unknown id: nothing to remove.
  }
}

/** Drops uploads nobody finished. */
export async function sweepExpiredUploads(): Promise<void> {
  const db = getDb();
  const expired = await db.select().from(radioUploads).where(lt(radioUploads.expiresAt, new Date())).all();
  for (const row of expired) await abortUpload(row.stationId, row.id);
}
