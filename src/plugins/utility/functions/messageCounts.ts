import { and, eq, sql } from "drizzle-orm";
import { offloaded } from "../../../core/offload.js";
import { cachedSwr } from "../../../bridge/responseCache.js";
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

export function getTotalGuildMessages(guildId: string): Promise<number> {
  // A sum over every member's row (hundreds of thousands in a big server): reused for a couple of minutes.
  return cachedSwr(`guild:${guildId}:messages-total`, 2 * 60_000, 30 * 60_000, () => computeGuildMessagesTotal(guildId));
}

export const computeGuildMessagesTotal = offloaded("plugins/utility/functions/messageCounts", "computeGuildMessagesTotal", async function computeGuildMessagesTotal(guildId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${guildMessageCounts.count}), 0)` })
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.guildId, guildId))
    .get();
  return Number(row?.total ?? 0);
});

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
