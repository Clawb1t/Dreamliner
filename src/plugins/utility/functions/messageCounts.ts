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

  await db
    .insert(userMessageCounts)
    .values({ userId, count: 1 })
    .onConflictDoUpdate({
      target: userMessageCounts.userId,
      set: { count: sql`${userMessageCounts.count} + 1` },
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
