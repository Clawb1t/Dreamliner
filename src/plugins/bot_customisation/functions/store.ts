import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { botAvatarRequests } from "../../../db/schema.js";

export type BotAvatarRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "failed"
  | "cancelled"
  | "superseded";

export type BotAvatarRequest = {
  id: number;
  guildId: string;
  requesterId: string;
  requestChannelId: string;
  requestMessageId: string | null;
  reviewMessageId: string | null;
  avatarPng: string;
  status: BotAvatarRequestStatus;
  reviewerId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

function mapRow(row: typeof botAvatarRequests.$inferSelect): BotAvatarRequest {
  return {
    id: row.id,
    guildId: row.guildId,
    requesterId: row.requesterId,
    requestChannelId: row.requestChannelId,
    requestMessageId: row.requestMessageId,
    reviewMessageId: row.reviewMessageId,
    avatarPng: row.avatarPng,
    status: row.status as BotAvatarRequestStatus,
    reviewerId: row.reviewerId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export async function getPendingBotAvatarRequest(guildId: string): Promise<BotAvatarRequest | null> {
  const rows = await getDb()
    .select()
    .from(botAvatarRequests)
    .where(and(eq(botAvatarRequests.guildId, guildId), eq(botAvatarRequests.status, "pending")))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createBotAvatarRequest(input: {
  guildId: string;
  requesterId: string;
  requestChannelId: string;
  avatarPngBase64: string;
}): Promise<BotAvatarRequest> {
  const inserted = await getDb()
    .insert(botAvatarRequests)
    .values({
      guildId: input.guildId,
      requesterId: input.requesterId,
      requestChannelId: input.requestChannelId,
      avatarPng: input.avatarPngBase64,
      status: "pending",
      createdAt: new Date(),
    })
    .returning();

  return mapRow(inserted[0]!);
}

/** Cancel the pending request for a guild. Returns the cancelled row, or null if none. */
export async function cancelPendingBotAvatarRequest(
  guildId: string,
  cancelledBy: string,
): Promise<BotAvatarRequest | null> {
  const updated = await getDb()
    .update(botAvatarRequests)
    .set({
      status: "cancelled",
      reviewerId: cancelledBy,
      resolvedAt: new Date(),
    })
    .where(and(eq(botAvatarRequests.guildId, guildId), eq(botAvatarRequests.status, "pending")))
    .returning();
  return updated[0] ? mapRow(updated[0]) : null;
}

export async function getBotAvatarRequest(id: number): Promise<BotAvatarRequest | null> {
  const rows = await getDb().select().from(botAvatarRequests).where(eq(botAvatarRequests.id, id)).limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function updateBotAvatarRequestMessageIds(
  id: number,
  ids: { requestMessageId?: string; reviewMessageId?: string },
): Promise<void> {
  await getDb()
    .update(botAvatarRequests)
    .set({
      ...(ids.requestMessageId !== undefined ? { requestMessageId: ids.requestMessageId } : {}),
      ...(ids.reviewMessageId !== undefined ? { reviewMessageId: ids.reviewMessageId } : {}),
    })
    .where(eq(botAvatarRequests.id, id));
}

export async function resolveBotAvatarRequest(
  id: number,
  status: Extract<BotAvatarRequestStatus, "approved" | "denied" | "failed">,
  reviewerId: string,
): Promise<BotAvatarRequest | null> {
  const updated = await getDb()
    .update(botAvatarRequests)
    .set({
      status,
      reviewerId,
      resolvedAt: new Date(),
    })
    .where(and(eq(botAvatarRequests.id, id), eq(botAvatarRequests.status, "pending")))
    .returning();
  return updated[0] ? mapRow(updated[0]) : null;
}

/** After a claimed approve fails to apply, mark the row failed. */
export async function markBotAvatarRequestFailed(id: number): Promise<void> {
  await getDb()
    .update(botAvatarRequests)
    .set({ status: "failed", resolvedAt: new Date() })
    .where(eq(botAvatarRequests.id, id));
}
