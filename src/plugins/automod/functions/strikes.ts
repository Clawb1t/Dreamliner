import { and, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { automodHits } from "../../../db/schema.js";

export async function recordAutomodHit(input: {
  guildId: string;
  userId: string;
  ruleId: string;
  channelId?: string | null;
  messageId?: string | null;
}): Promise<void> {
  await getDb().insert(automodHits).values({
    guildId: input.guildId,
    userId: input.userId,
    ruleId: input.ruleId,
    channelId: input.channelId ?? null,
    messageId: input.messageId ?? null,
    createdAt: new Date(),
  });
}

export async function countAutomodHits(input: {
  guildId: string;
  userId: string;
  ruleId: string;
  windowMs: number;
}): Promise<number> {
  const since = new Date(Date.now() - Math.max(1000, input.windowMs));
  const row = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(automodHits)
    .where(
      and(
        eq(automodHits.guildId, input.guildId),
        eq(automodHits.userId, input.userId),
        eq(automodHits.ruleId, input.ruleId),
        gt(automodHits.createdAt, since),
      ),
    )
    .get();
  return Number(row?.count ?? 0);
}

/** Best-effort prune of hits older than 30 days. */
export async function pruneOldAutomodHits(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  await getDb().delete(automodHits).where(lt(automodHits.createdAt, cutoff));
}
