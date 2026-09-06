import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Guild } from "discord.js";
import { getDb } from "../db/client.js";
import { evidenceMessages, logMessages } from "../db/schema.js";

/** Evidence snapshots are kept 42 days regardless of the server's content-retention
 * setting, the same fixed window as the `log_messages` table they're sourced from. */
const RETENTION_MS = 42 * 24 * 60 * 60 * 1000;

export type EvidenceSource = "case" | "manual";

export type CaptureEvidenceInput = {
  guildId: string;
  userId: string;
  limit: number;
  capturedBy?: string | null;
  source: EvidenceSource;
  caseId?: number | null;
};

export type CapturedEvidenceMessage = {
  channelId: string;
  /** Resolved from the live guild channel cache when a `Guild` is passed to the list
   * function, null when the channel no longer exists or none was provided. */
  channelName: string | null;
  messageId: string;
  authorName: string;
  content: string;
  sentAt: Date;
};

export type EvidenceCapture = {
  captureId: string;
  guildId: string;
  userId: string;
  source: EvidenceSource;
  caseId: number | null;
  capturedBy: string | null;
  capturedAt: string;
  expiresAt: string;
  messages: CapturedEvidenceMessage[];
};

/**
 * Snapshots a member's `limit` most recent messages (from `log_messages`, which already
 * retains 42 days of content for every message regardless of the server's content-retention
 * setting) into `evidence_messages` under one new capture id. Returns the number of messages
 * captured, 0 if the member has no recent tracked messages in this server.
 */
export async function captureEvidence(input: CaptureEvidenceInput): Promise<number> {
  const db = getDb();
  const rows = await db
    .select()
    .from(logMessages)
    .where(and(eq(logMessages.guildId, input.guildId), eq(logMessages.authorId, input.userId)))
    .orderBy(desc(logMessages.updatedAt))
    .limit(input.limit)
    .all();

  if (rows.length === 0) return 0;

  const captureId = randomUUID();
  const now = new Date();
  await db.insert(evidenceMessages).values(
    rows.map((row) => ({
      guildId: input.guildId,
      userId: input.userId,
      captureId,
      channelId: row.channelId,
      messageId: row.messageId,
      authorName: row.authorName,
      content: row.content,
      sentAt: row.updatedAt,
      capturedAt: now,
      capturedBy: input.capturedBy ?? null,
      source: input.source,
      caseId: input.caseId ?? null,
    })),
  );
  return rows.length;
}

/** Deletes evidence captures older than the fixed 42-day window. */
export async function sweepExpiredEvidence(): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const deleted = await db
    .delete(evidenceMessages)
    .where(lt(evidenceMessages.capturedAt, cutoff))
    .returning({ id: evidenceMessages.id });
  return deleted.length;
}

function groupIntoCaptures(
  rows: (typeof evidenceMessages.$inferSelect)[],
  guild?: Guild,
): EvidenceCapture[] {
  const byCapture = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byCapture.get(row.captureId) ?? [];
    list.push(row);
    byCapture.set(row.captureId, list);
  }

  const captures: EvidenceCapture[] = [];
  for (const [captureId, groupRows] of byCapture) {
    const first = groupRows[0]!;
    const capturedAt = first.capturedAt;
    captures.push({
      captureId,
      guildId: first.guildId,
      userId: first.userId,
      source: first.source as EvidenceSource,
      caseId: first.caseId,
      capturedBy: first.capturedBy,
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + RETENTION_MS).toISOString(),
      messages: groupRows
        .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
        .map((row) => ({
          channelId: row.channelId,
          channelName: guild?.channels.cache.get(row.channelId)?.name ?? null,
          messageId: row.messageId,
          authorName: row.authorName,
          content: row.content,
          sentAt: row.sentAt,
        })),
    });
  }

  captures.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  return captures;
}

export type ListEvidenceQuery = {
  userId?: string;
  caseId?: number;
  source?: EvidenceSource;
  limit?: number;
  offset?: number;
};

/** Lists evidence captures for a guild, newest first, grouped by capture batch. Channel names
 * are resolved from the live guild's channel cache. */
export async function listEvidenceCaptures(
  guild: Guild,
  query: ListEvidenceQuery = {},
): Promise<{ captures: EvidenceCapture[]; total: number }> {
  const db = getDb();
  const filters = [eq(evidenceMessages.guildId, guild.id)];
  if (query.userId) filters.push(eq(evidenceMessages.userId, query.userId));
  if (query.caseId != null) filters.push(eq(evidenceMessages.caseId, query.caseId));
  if (query.source) filters.push(eq(evidenceMessages.source, query.source));

  const rows = await db
    .select()
    .from(evidenceMessages)
    .where(and(...filters))
    .orderBy(desc(evidenceMessages.capturedAt))
    .all();

  const captures = groupIntoCaptures(rows, guild);
  const limit = query.limit ?? 40;
  const offset = query.offset ?? 0;
  return { captures: captures.slice(offset, offset + limit), total: captures.length };
}

/** Every evidence capture tied to a specific case (auto-captured, or manually added and
 * later linked). Channel names are resolved from the live guild's channel cache. */
export async function listEvidenceForCase(guild: Guild, caseId: number): Promise<EvidenceCapture[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(evidenceMessages)
    .where(and(eq(evidenceMessages.guildId, guild.id), eq(evidenceMessages.caseId, caseId)))
    .orderBy(desc(evidenceMessages.capturedAt))
    .all();
  return groupIntoCaptures(rows, guild);
}

export async function listEvidenceForCases(
  guild: Guild,
  caseIds: number[],
): Promise<Map<number, EvidenceCapture[]>> {
  const map = new Map<number, EvidenceCapture[]>();
  if (caseIds.length === 0) return map;
  const db = getDb();
  const rows = await db
    .select()
    .from(evidenceMessages)
    .where(and(eq(evidenceMessages.guildId, guild.id), inArray(evidenceMessages.caseId, caseIds)))
    .orderBy(desc(evidenceMessages.capturedAt))
    .all();
  const byCase = new Map<number, typeof rows>();
  for (const row of rows) {
    if (row.caseId == null) continue;
    const list = byCase.get(row.caseId) ?? [];
    list.push(row);
    byCase.set(row.caseId, list);
  }
  for (const [caseId, groupRows] of byCase) {
    map.set(caseId, groupIntoCaptures(groupRows, guild));
  }
  return map;
}
