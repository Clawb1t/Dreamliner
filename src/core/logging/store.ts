import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { guildLogEvents } from "../../db/schema.js";
import type { LogEventCategory, LogEventType } from "./events.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const pruneBuckets = new Map<string, number>();

export type InsertGuildLogEventInput = {
  guildId: string;
  category: LogEventCategory;
  eventType: LogEventType;
  title: string;
  summary: string;
  actorId?: string | null;
  targetId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  caseId?: number | null;
  payload?: Record<string, unknown>;
};

export async function insertGuildLogEvent(input: InsertGuildLogEventInput): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  await db.insert(guildLogEvents).values({
    id,
    guildId: input.guildId,
    createdAt: new Date(),
    category: input.category,
    eventType: input.eventType,
    title: input.title,
    summary: input.summary.slice(0, 500),
    actorId: input.actorId ?? null,
    targetId: input.targetId ?? null,
    channelId: input.channelId ?? null,
    messageId: input.messageId ?? null,
    caseId: input.caseId ?? null,
    payload: JSON.stringify(input.payload ?? {}),
    discordMessageId: null,
  });

  void maybePruneGuildLogs(input.guildId);
  return id;
}

export async function setGuildLogDiscordMessageId(
  guildId: string,
  logId: string,
  discordMessageId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(guildLogEvents)
    .set({ discordMessageId })
    .where(and(eq(guildLogEvents.guildId, guildId), eq(guildLogEvents.id, logId)));
}

async function maybePruneGuildLogs(guildId: string): Promise<void> {
  const now = Date.now();
  const last = pruneBuckets.get(guildId) ?? 0;
  if (now - last < 15 * 60 * 1000) return;
  pruneBuckets.set(guildId, now);

  const cutoff = new Date(now - RETENTION_MS);
  const db = getDb();
  await db
    .delete(guildLogEvents)
    .where(and(eq(guildLogEvents.guildId, guildId), lt(guildLogEvents.createdAt, cutoff)));
}

export async function countGuildLogEvents(guildId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ value: sql<number>`count(*)` })
    .from(guildLogEvents)
    .where(eq(guildLogEvents.guildId, guildId));
  return Number(rows[0]?.value ?? 0);
}
