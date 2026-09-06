import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ASSETS_ROOT = join(ROOT, "data", "guild-assets");

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function caseEvidenceDir(guildId: string, caseId: number): string {
  return join(ASSETS_ROOT, guildId, "cases", String(caseId));
}

function safeSegment(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== id) throw new Error("Invalid file id");
  return safe;
}

export function caseEvidencePath(guildId: string, caseId: number, fileId: string, ext: string): string {
  return join(caseEvidenceDir(guildId, caseId), `${safeSegment(fileId)}.${ext}`);
}

export type DecodedUpload = { buffer: Buffer; mimeType: string; ext: string };

/** Decodes a `data:image/...;base64,...` (or bare base64, assumed PNG) string, enforcing the
 * size limit and a known image mime type. */
export function decodeImageUpload(imageBase64: string): DecodedUpload {
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(imageBase64.trim());
  const mimeType = match ? match[1]!.toLowerCase() : "image/png";
  const raw = match ? match[2]! : imageBase64.trim();
  const ext = MIME_EXTENSIONS[mimeType];
  if (!ext) throw new Error("Unsupported image type, use PNG, JPEG, GIF, or WebP.");

  const buffer = Buffer.from(raw, "base64");
  if (buffer.length === 0) throw new Error("Empty image data");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Image is too large, max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`);
  }
  return { buffer, mimeType, ext };
}

export function saveCaseEvidenceFile(
  guildId: string,
  caseId: number,
  upload: DecodedUpload,
): { fileId: string; fileName: string } {
  const fileId = randomUUID();
  const dir = caseEvidenceDir(guildId, caseId);
  mkdirSync(dir, { recursive: true });
  const path = caseEvidencePath(guildId, caseId, fileId, upload.ext);
  writeFileSync(path, upload.buffer);
  return { fileId, fileName: `${fileId}.${upload.ext}` };
}

export function readCaseEvidenceFile(fileName: string, guildId: string, caseId: number): Buffer | null {
  try {
    const path = join(caseEvidenceDir(guildId, caseId), safeSegment(fileName.replace(/\.[a-z0-9]+$/i, "")) + extOf(fileName));
    if (!existsSync(path)) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function extOf(fileName: string): string {
  const match = /\.[a-z0-9]+$/i.exec(fileName);
  return match ? match[0] : "";
}

export function deleteCaseEvidenceFileFromDisk(fileName: string, guildId: string, caseId: number): boolean {
  try {
    const path = join(caseEvidenceDir(guildId, caseId), safeSegment(fileName.replace(/\.[a-z0-9]+$/i, "")) + extOf(fileName));
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Deletes every stored screenshot for a case (e.g. when the case itself is deleted). */
export function deleteAllCaseEvidenceFiles(guildId: string, caseId: number): void {
  try {
    rmSync(caseEvidenceDir(guildId, caseId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export function mimeTypeForFileName(fileName: string): string {
  const ext = extOf(fileName).slice(1).toLowerCase();
  const entry = Object.entries(MIME_EXTENSIONS).find(([, e]) => e === ext);
  return entry?.[0] ?? "application/octet-stream";
}
