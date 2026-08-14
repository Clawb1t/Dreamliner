import { and, desc, eq, notLike, or } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildLogEvents, guildUserTrail, logMessages } from "../../../db/schema.js";
import { isLogEventType, LOG_EVENT_META } from "../../../core/logging/events.js";
import { snowflakeToTimestamp } from "../../../core/datetime.js";

export type LastSeenHit = {
  at: Date;
  action: string;
  channelId: string | null;
};

function asDate(value: Date | number | string | null | undefined): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  return null;
}

function pickNewest(hits: Array<LastSeenHit | null>): LastSeenHit | null {
  return hits.reduce<LastSeenHit | null>((best, hit) => {
    if (!hit) return best;
    if (!best || hit.at.getTime() > best.at.getTime()) return hit;
    return best;
  }, null);
}

async function fromTrail(guildId: string, userId: string): Promise<LastSeenHit | null> {
  try {
    const db = getDb();
    const row = await db
      .select()
      .from(guildUserTrail)
      .where(and(eq(guildUserTrail.guildId, guildId), eq(guildUserTrail.userId, userId)))
      .orderBy(desc(guildUserTrail.endedAt))
      .limit(1)
      .get();
    const at = asDate(row?.endedAt);
    if (!row || !at) return null;
    return {
      at,
      action: `Spoke in <#${row.channelId}>`,
      channelId: row.channelId,
    };
  } catch {
    return null;
  }
}

async function fromLogMessages(guildId: string, userId: string): Promise<LastSeenHit | null> {
  try {
    const db = getDb();
    const row = await db
      .select({
        channelId: logMessages.channelId,
        messageId: logMessages.messageId,
      })
      .from(logMessages)
      .where(and(eq(logMessages.guildId, guildId), eq(logMessages.authorId, userId)))
      .orderBy(desc(logMessages.messageId))
      .limit(1)
      .get();
    if (!row) return null;
    return {
      at: snowflakeToTimestamp(row.messageId),
      action: `Spoke in <#${row.channelId}>`,
      channelId: row.channelId,
    };
  } catch {
    return null;
  }
}

async function fromLogEvents(guildId: string, userId: string): Promise<LastSeenHit | null> {
  try {
    const db = getDb();
    const row = await db
      .select({
        createdAt: guildLogEvents.createdAt,
        eventType: guildLogEvents.eventType,
        title: guildLogEvents.title,
        summary: guildLogEvents.summary,
        channelId: guildLogEvents.channelId,
      })
      .from(guildLogEvents)
      .where(
        and(
          eq(guildLogEvents.guildId, guildId),
          or(eq(guildLogEvents.actorId, userId), eq(guildLogEvents.targetId, userId)),
          notLike(guildLogEvents.eventType, "dashboard_%"),
        ),
      )
      .orderBy(desc(guildLogEvents.createdAt))
      .limit(1)
      .get();
    const at = asDate(row?.createdAt);
    if (!row || !at) return null;
    const label = isLogEventType(row.eventType)
      ? LOG_EVENT_META[row.eventType].label
      : row.title;
    const action = row.summary?.trim() || label;
    return {
      at,
      action,
      channelId: row.channelId,
    };
  } catch {
    return null;
  }
}

export async function getLastSeen(guildId: string, userId: string): Promise<LastSeenHit | null> {
  const [trail, message, event] = await Promise.all([
    fromTrail(guildId, userId),
    fromLogMessages(guildId, userId),
    fromLogEvents(guildId, userId),
  ]);
  return pickNewest([trail, message, event]);
}
