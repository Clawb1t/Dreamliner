import { randomBytes } from "node:crypto";
import { and, count, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import type { Client, Guild } from "discord.js";
import { getDb } from "../db/client.js";
import { caseEvidenceFiles, modCases } from "../db/schema.js";
import { INFRACTION_TYPES } from "../config/schemas/infraction.js";
import { listEvidenceForCase, type EvidenceCapture } from "../core/evidence.js";
import {
  decodeImageUpload,
  deleteAllCaseEvidenceFiles,
  deleteCaseEvidenceFileFromDisk,
  mimeTypeForFileName,
  readCaseEvidenceFile,
  saveCaseEvidenceFile,
} from "../plugins/infraction/functions/evidenceAssets.js";

export type WebPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

export type WebCaseEvidenceFile = {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  caption: string | null;
  uploadedBy: string;
  uploadedAt: string;
};

export type WebModCase = {
  id: number;
  type: string;
  reason: string | null;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
  user: WebPerson;
  mod: WebPerson;
  metadata?: Record<string, unknown> | null;
  public?: boolean;
  shareToken?: string | null;
  publicNote?: string | null;
  publishedAt?: string | null;
  evidenceCaptures?: EvidenceCapture[];
  evidenceFiles?: WebCaseEvidenceFile[];
};

const CASE_TYPES = [...INFRACTION_TYPES, "clean"] as const;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type WebModCasesQuery = {
  q: string;
  type: string | null;
  active: boolean | null;
  targetUserId: string | null;
  modId: string | null;
  limit: number;
  offset: number;
};

export function parseWebModCasesQuery(url: URL): WebModCasesQuery {
  const activeRaw = url.searchParams.get("active");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const type = url.searchParams.get("type")?.trim() || null;
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    type: type && CASE_TYPES.includes(type as (typeof CASE_TYPES)[number]) ? type : type,
    active: activeRaw === "true" ? true : activeRaw === "false" ? false : null,
    targetUserId: url.searchParams.get("target")?.trim() || null,
    modId: url.searchParams.get("mod")?.trim() || null,
    limit,
    offset,
  };
}

async function resolvePerson(guild: Guild, userId: string): Promise<WebPerson> {
  if (!userId || userId === "0") {
    return { id: userId || "0", name: "Unknown", username: null, avatar: null };
  }
  const member = await guild.members.fetch(userId).catch(() => null);
  const user =
    member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  return {
    id: userId,
    name: member?.displayName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

async function resolvePeopleMap(guild: Guild, ids: string[]): Promise<Map<string, WebPerson>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const entries = await Promise.all(unique.map(async (id) => [id, await resolvePerson(guild, id)] as const));
  return new Map(entries);
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function buildFilters(guildId: string, query: WebModCasesQuery): SQL[] {
  const filters: SQL[] = [eq(modCases.guildId, guildId)];

  if (query.type) filters.push(eq(modCases.type, query.type));
  if (query.active != null) filters.push(eq(modCases.active, query.active));
  if (query.targetUserId) filters.push(eq(modCases.userId, query.targetUserId));
  if (query.modId) filters.push(eq(modCases.modId, query.modId));

  const q = query.q;
  if (q) {
    const idNum = Number(q.replace(/^#/, ""));
    if (!Number.isNaN(idNum) && idNum > 0 && String(idNum) === q.replace(/^#/, "")) {
      filters.push(eq(modCases.id, idNum));
    } else if (/^\d{17,20}$/.test(q)) {
      filters.push(or(eq(modCases.userId, q), eq(modCases.modId, q))!);
    } else {
      filters.push(
        or(
          like(modCases.reason, `%${q}%`),
          like(modCases.type, `%${q}%`),
          sql`cast(${modCases.id} as text) like ${`%${q}%`}`,
        )!,
      );
    }
  }

  return filters;
}

export async function listWebModCases(guild: Guild, query: WebModCasesQuery) {
  const db = getDb();
  const where = and(...buildFilters(guild.id, query))!;

  const [totalRow] = await db.select({ value: count() }).from(modCases).where(where);
  const rows = await db
    .select()
    .from(modCases)
    .where(where)
    .orderBy(desc(modCases.id))
    .limit(query.limit)
    .offset(query.offset);

  const people = await resolvePeopleMap(
    guild,
    rows.flatMap((row) => [row.userId, row.modId]),
  );

  const cases: WebModCase[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    reason: row.reason,
    active: row.active,
    expiresAt: toIso(row.expiresAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    user: people.get(row.userId) ?? {
      id: row.userId,
      name: row.userId,
      username: null,
      avatar: null,
    },
    mod: people.get(row.modId) ?? {
      id: row.modId,
      name: row.modId,
      username: null,
      avatar: null,
    },
  }));

  return {
    cases,
    total: Number(totalRow?.value ?? 0),
    limit: query.limit,
    offset: query.offset,
    types: [...CASE_TYPES],
  };
}

export async function getWebModCase(guild: Guild, caseId: number) {
  const db = getDb();
  const row = await db
    .select()
    .from(modCases)
    .where(and(eq(modCases.guildId, guild.id), eq(modCases.id, caseId)))
    .get();

  if (!row) return null;

  const [user, mod] = await Promise.all([
    resolvePerson(guild, row.userId),
    resolvePerson(guild, row.modId),
  ]);

  const [evidenceCaptures, evidenceFileRows] = await Promise.all([
    listEvidenceForCase(guild, caseId),
    db.select().from(caseEvidenceFiles).where(eq(caseEvidenceFiles.caseId, caseId)).all(),
  ]);

  const detail: WebModCase = {
    id: row.id,
    type: row.type,
    reason: row.reason,
    active: row.active,
    expiresAt: toIso(row.expiresAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    user,
    mod,
    metadata: parseMetadata(row.metadata),
    public: row.public,
    shareToken: row.shareToken,
    publicNote: row.publicNote,
    publishedAt: toIso(row.publishedAt),
    evidenceCaptures,
    evidenceFiles: evidenceFileRows.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      byteSize: file.byteSize,
      caption: file.caption,
      uploadedBy: file.uploadedBy,
      uploadedAt: toIso(file.uploadedAt) ?? new Date(0).toISOString(),
    })),
  };

  return detail;
}

export type UpdateWebModCaseInput = {
  reason?: string;
  active?: boolean;
  expiresAt?: Date | null;
  publicNote?: string;
};

export async function updateWebModCase(
  guild: Guild,
  caseId: number,
  patch: UpdateWebModCaseInput,
): Promise<WebModCase | null> {
  const db = getDb();
  const existing = await db
    .select({ id: modCases.id })
    .from(modCases)
    .where(and(eq(modCases.guildId, guild.id), eq(modCases.id, caseId)))
    .get();
  if (!existing) return null;

  const set: Partial<typeof modCases.$inferInsert> = {};
  if (patch.reason !== undefined) set.reason = patch.reason;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (patch.publicNote !== undefined) set.publicNote = patch.publicNote;

  if (Object.keys(set).length > 0) {
    await db.update(modCases).set(set).where(eq(modCases.id, caseId));
  }
  return getWebModCase(guild, caseId);
}

/** Generates a fresh share token and marks the case public. Returns false if the case
 * doesn't exist. */
export async function publishWebModCase(guildId: string, caseId: number): Promise<boolean> {
  const db = getDb();
  const existing = await db
    .select({ id: modCases.id })
    .from(modCases)
    .where(and(eq(modCases.guildId, guildId), eq(modCases.id, caseId)))
    .get();
  if (!existing) return false;

  const shareToken = randomBytes(16).toString("hex");
  await db
    .update(modCases)
    .set({ public: true, shareToken, publishedAt: new Date() })
    .where(eq(modCases.id, caseId));
  return true;
}

/** Un-publishes a case and invalidates its share link (a later re-publish gets a fresh token). */
export async function unpublishWebModCase(guildId: string, caseId: number): Promise<boolean> {
  const db = getDb();
  const existing = await db
    .select({ id: modCases.id })
    .from(modCases)
    .where(and(eq(modCases.guildId, guildId), eq(modCases.id, caseId)))
    .get();
  if (!existing) return false;

  await db
    .update(modCases)
    .set({ public: false, shareToken: null, publishedAt: null })
    .where(eq(modCases.id, caseId));
  return true;
}

export async function uploadCaseEvidenceFile(
  guildId: string,
  caseId: number,
  uploadedBy: string,
  input: { imageBase64: string; caption?: string | null },
): Promise<WebCaseEvidenceFile> {
  const db = getDb();
  const existing = await db
    .select({ id: modCases.id })
    .from(modCases)
    .where(and(eq(modCases.guildId, guildId), eq(modCases.id, caseId)))
    .get();
  if (!existing) throw new Error("Case not found");

  const upload = decodeImageUpload(input.imageBase64);
  const { fileId, fileName } = saveCaseEvidenceFile(guildId, caseId, upload);
  const uploadedAt = new Date();

  await db.insert(caseEvidenceFiles).values({
    id: fileId,
    caseId,
    guildId,
    fileName,
    mimeType: upload.mimeType,
    byteSize: upload.buffer.length,
    caption: input.caption ?? null,
    uploadedBy,
    uploadedAt,
  });

  return {
    id: fileId,
    fileName,
    mimeType: upload.mimeType,
    byteSize: upload.buffer.length,
    caption: input.caption ?? null,
    uploadedBy,
    uploadedAt: uploadedAt.toISOString(),
  };
}

export async function deleteCaseEvidenceFile(guildId: string, caseId: number, fileId: string): Promise<void> {
  const db = getDb();
  const row = await db
    .select()
    .from(caseEvidenceFiles)
    .where(and(eq(caseEvidenceFiles.id, fileId), eq(caseEvidenceFiles.caseId, caseId)))
    .get();
  if (!row) return;
  deleteCaseEvidenceFileFromDisk(row.fileName, guildId, caseId);
  await db.delete(caseEvidenceFiles).where(eq(caseEvidenceFiles.id, fileId));
}

/** Deletes every uploaded screenshot for a case. Call this when the case itself is deleted. */
export async function deleteCaseEvidenceFilesForCase(guildId: string, caseId: number): Promise<void> {
  const db = getDb();
  await db.delete(caseEvidenceFiles).where(eq(caseEvidenceFiles.caseId, caseId));
  deleteAllCaseEvidenceFiles(guildId, caseId);
}

/** Authenticated read of an uploaded screenshot (dashboard case view). */
export async function getWebCaseEvidenceFile(
  guildId: string,
  caseId: number,
  fileId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(caseEvidenceFiles)
    .where(and(eq(caseEvidenceFiles.id, fileId), eq(caseEvidenceFiles.caseId, caseId)))
    .get();
  if (!row) return null;
  const buffer = readCaseEvidenceFile(row.fileName, guildId, caseId);
  if (!buffer) return null;
  return { buffer, mimeType: row.mimeType };
}

export type PublicCaseDetail = {
  guild: { id: string; name: string; icon: string | null };
  case: {
    id: number;
    type: string;
    createdAt: string;
    reason: string | null;
    publicNote: string | null;
    target: WebPerson;
    mod: WebPerson;
    evidenceCaptures: EvidenceCapture[];
    evidenceFiles: Array<Omit<WebCaseEvidenceFile, "uploadedBy">>;
  };
};

/** Looked up by share token across every guild, the caller only has the link, not the
 * guild id. Returns null unless the case exists and is currently public. */
export async function getPublicCase(client: Client, token: string): Promise<PublicCaseDetail | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(modCases)
    .where(and(eq(modCases.shareToken, token), eq(modCases.public, true)))
    .get();
  if (!row) return null;

  const guild = client.guilds.cache.get(row.guildId);
  if (!guild) return null;

  const [target, mod, evidenceCaptures, evidenceFileRows] = await Promise.all([
    resolvePerson(guild, row.userId),
    resolvePerson(guild, row.modId),
    listEvidenceForCase(guild, row.id),
    db.select().from(caseEvidenceFiles).where(eq(caseEvidenceFiles.caseId, row.id)).all(),
  ]);

  return {
    guild: { id: guild.id, name: guild.name, icon: guild.icon },
    case: {
      id: row.id,
      type: row.type,
      createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
      reason: row.reason,
      publicNote: row.publicNote,
      target,
      mod,
      evidenceCaptures,
      evidenceFiles: evidenceFileRows.map((file) => ({
        id: file.id,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        caption: file.caption,
        uploadedAt: toIso(file.uploadedAt) ?? new Date(0).toISOString(),
      })),
    },
  };
}

/** Token-scoped file read for the public case page. Verifies the file actually belongs to
 * that token's (still-public) case before returning bytes, so a guessed file id on its own
 * isn't enough to read it. */
export async function getPublicCaseFile(
  token: string,
  fileId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const db = getDb();
  const caseRow = await db
    .select({ id: modCases.id, guildId: modCases.guildId })
    .from(modCases)
    .where(and(eq(modCases.shareToken, token), eq(modCases.public, true)))
    .get();
  if (!caseRow) return null;

  const fileRow = await db
    .select()
    .from(caseEvidenceFiles)
    .where(and(eq(caseEvidenceFiles.id, fileId), eq(caseEvidenceFiles.caseId, caseRow.id)))
    .get();
  if (!fileRow) return null;

  const buffer = readCaseEvidenceFile(fileRow.fileName, caseRow.guildId, caseRow.id);
  if (!buffer) return null;
  return { buffer, mimeType: fileRow.mimeType || mimeTypeForFileName(fileRow.fileName) };
}
