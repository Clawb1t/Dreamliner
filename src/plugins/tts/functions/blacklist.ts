import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { ttsBlacklist } from "../../../db/schema.js";

export type TtsBlacklistEntry = {
  guildId: string;
  userId: string;
  reason: string | null;
  createdAt: Date;
};

function rowToEntry(row: typeof ttsBlacklist.$inferSelect): TtsBlacklistEntry {
  return { guildId: row.guildId, userId: row.userId, reason: row.reason ?? null, createdAt: row.createdAt };
}

export async function listTtsBlacklist(guildId: string): Promise<TtsBlacklistEntry[]> {
  const rows = await getDb().select().from(ttsBlacklist).where(eq(ttsBlacklist.guildId, guildId));
  return rows.map(rowToEntry);
}

export async function addToTtsBlacklist(guildId: string, userId: string, reason?: string | null): Promise<void> {
  await getDb()
    .insert(ttsBlacklist)
    .values({ guildId, userId, reason: reason ?? null, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [ttsBlacklist.guildId, ttsBlacklist.userId],
      set: { reason: reason ?? null },
    });
}

export async function removeFromTtsBlacklist(guildId: string, userId: string): Promise<void> {
  await getDb().delete(ttsBlacklist).where(and(eq(ttsBlacklist.guildId, guildId), eq(ttsBlacklist.userId, userId)));
}

export async function isTtsBlacklisted(guildId: string, userId: string): Promise<boolean> {
  const row = await getDb()
    .select()
    .from(ttsBlacklist)
    .where(and(eq(ttsBlacklist.guildId, guildId), eq(ttsBlacklist.userId, userId)))
    .get();
  return Boolean(row);
}
