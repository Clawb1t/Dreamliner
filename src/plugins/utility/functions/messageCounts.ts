import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildMessageCounts, userMessageCounts } from "../../../db/schema.js";

export async function recordUserMessage(guildId: string, userId: string): Promise<void> {
  const db = getDb();

  await db
    .insert(guildMessageCounts)
    .values({ guildId, userId, count: 1 })
    .onConflictDoUpdate({
      target: [guildMessageCounts.guildId, guildMessageCounts.userId],
      set: { count: sql`${guildMessageCounts.count} + 1` },
    });

  const now = new Date();
  await db
    .insert(userMessageCounts)
    .values({ userId, count: 1, lastMessageAt: now })
    .onConflictDoUpdate({
      target: userMessageCounts.userId,
      set: { count: sql`${userMessageCounts.count} + 1`, lastMessageAt: now },
    });
}

export async function getGuildMessageCount(guildId: string, userId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select()
    .from(guildMessageCounts)
    .where(and(eq(guildMessageCounts.guildId, guildId), eq(guildMessageCounts.userId, userId)))
    .get();
  return row?.count ?? 0;
}

export async function getGlobalMessageCount(userId: string): Promise<number> {
  const db = getDb();
  const row = await db.select().from(userMessageCounts).where(eq(userMessageCounts.userId, userId)).get();
  return row?.count ?? 0;
}

export async function getTotalGuildMessages(guildId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${guildMessageCounts.count}), 0)` })
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.guildId, guildId))
    .get();
  return Number(row?.total ?? 0);
}

export async function getTopMessageSenders(guildId: string, limit = 5): Promise<{ userId: string; count: number }[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.guildId, guildId))
    .orderBy(sql`${guildMessageCounts.count} desc`)
    .limit(limit);
  return rows.map((row) => ({ userId: row.userId, count: row.count }));
}
