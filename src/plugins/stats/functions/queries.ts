import { and, count, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildMessageCounts, logMessages } from "../../../db/schema.js";

export async function getTotalGuildMessages(guildId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${guildMessageCounts.count}), 0)` })
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.guildId, guildId))
    .get();
  return row?.total ?? 0;
}

export async function getChannelTrackedMessages(guildId: string, channelId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: count() })
    .from(logMessages)
    .where(and(eq(logMessages.guildId, guildId), eq(logMessages.channelId, channelId)))
    .get();
  return row?.total ?? 0;
}

export async function getTopMessagers(guildId: string, limit = 5): Promise<{ userId: string; count: number }[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.guildId, guildId))
    .orderBy(sql`${guildMessageCounts.count} desc`)
    .limit(limit);
  return rows.map((row) => ({ userId: row.userId, count: row.count }));
}
