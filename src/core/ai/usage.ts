import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { guildAiUsage } from "../../db/schema.js";
import { isDreamlinerOneActive } from "../../bridge/dreamlinerOne.js";

/** Total free AI generations a non-Dreamliner-One guild gets, shared across every AI
 * feature (not per-field, not per-page). See gate.ts for enforcement. */
export const AI_FREE_USES_LIMIT = 4;

export type AiGateStatus = {
  oneActive: boolean;
  freeUsesRemaining: number;
};

async function getUsageRow(guildId: string) {
  return getDb().select().from(guildAiUsage).where(eq(guildAiUsage.guildId, guildId)).get();
}

/** Read-only peek at a guild's AI standing, does not consume anything. */
export async function getAiGateStatus(guildId: string): Promise<AiGateStatus> {
  const oneActive = await isDreamlinerOneActive(guildId);
  if (oneActive) return { oneActive, freeUsesRemaining: AI_FREE_USES_LIMIT };
  const row = await getUsageRow(guildId);
  const consumed = row?.freeUsesConsumed ?? 0;
  return { oneActive, freeUsesRemaining: Math.max(0, AI_FREE_USES_LIMIT - consumed) };
}

/** Atomically consumes one free use (out of AI_FREE_USES_LIMIT total) for a non-One guild.
 * Returns false if none remain. */
export async function consumeFreeAiUse(guildId: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const row = await getUsageRow(guildId);

  if (!row) {
    if (AI_FREE_USES_LIMIT <= 0) return false;
    await db.insert(guildAiUsage).values({ guildId, freeUsesConsumed: 1, lastUsedAt: now });
    return true;
  }

  if (row.freeUsesConsumed >= AI_FREE_USES_LIMIT) return false;

  await db
    .update(guildAiUsage)
    .set({ freeUsesConsumed: row.freeUsesConsumed + 1, lastUsedAt: now })
    .where(eq(guildAiUsage.guildId, guildId));
  return true;
}
