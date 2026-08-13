import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { botAvatarRequests, botGuildProfiles } from "../../../db/schema.js";

export type BotBrandImageKind = "avatar" | "banner";

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
  kind: BotBrandImageKind;
  status: BotAvatarRequestStatus;
  reviewerId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export const DASHBOARD_REQUEST_CHANNEL = "dashboard";

function mapRow(row: typeof botAvatarRequests.$inferSelect): BotAvatarRequest {
  return {
    id: row.id,
    guildId: row.guildId,
    requesterId: row.requesterId,
    requestChannelId: row.requestChannelId,
    requestMessageId: row.requestMessageId,
    reviewMessageId: row.reviewMessageId,
    avatarPng: row.avatarPng,
    kind: row.kind === "banner" ? "banner" : "avatar",
    status: row.status as BotAvatarRequestStatus,
    reviewerId: row.reviewerId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export async function getPendingBotBrandRequest(
  guildId: string,
  kind: BotBrandImageKind,
): Promise<BotAvatarRequest | null> {
  const rows = await getDb()
    .select()
    .from(botAvatarRequests)
    .where(
      and(
        eq(botAvatarRequests.guildId, guildId),
        eq(botAvatarRequests.status, "pending"),
        eq(botAvatarRequests.kind, kind),
      ),
    )
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** @deprecated Prefer getPendingBotBrandRequest(guildId, "avatar") */
export async function getPendingBotAvatarRequest(guildId: string): Promise<BotAvatarRequest | null> {
  return getPendingBotBrandRequest(guildId, "avatar");
}

export async function listPendingBotBrandRequests(guildId: string): Promise<BotAvatarRequest[]> {
  const rows = await getDb()
    .select()
    .from(botAvatarRequests)
    .where(and(eq(botAvatarRequests.guildId, guildId), eq(botAvatarRequests.status, "pending")))
    .orderBy(desc(botAvatarRequests.createdAt));
  return rows.map(mapRow);
}

export async function listRecentBotBrandRequests(
  guildId: string,
  limit = 12,
): Promise<BotAvatarRequest[]> {
  const rows = await getDb()
    .select()
    .from(botAvatarRequests)
    .where(eq(botAvatarRequests.guildId, guildId))
    .orderBy(desc(botAvatarRequests.createdAt))
    .limit(Math.max(1, Math.min(limit, 50)));
  return rows.map(mapRow);
}

export async function getLatestApprovedBrandRequest(
  guildId: string,
  kind: BotBrandImageKind,
): Promise<BotAvatarRequest | null> {
  const rows = await getDb()
    .select()
    .from(botAvatarRequests)
    .where(
      and(
        eq(botAvatarRequests.guildId, guildId),
        eq(botAvatarRequests.kind, kind),
        eq(botAvatarRequests.status, "approved"),
      ),
    )
    .orderBy(desc(botAvatarRequests.resolvedAt), desc(botAvatarRequests.createdAt))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createBotBrandRequest(input: {
  guildId: string;
  requesterId: string;
  requestChannelId: string;
  imagePngBase64: string;
  kind: BotBrandImageKind;
}): Promise<BotAvatarRequest> {
  const inserted = await getDb()
    .insert(botAvatarRequests)
    .values({
      guildId: input.guildId,
      requesterId: input.requesterId,
      requestChannelId: input.requestChannelId,
      avatarPng: input.imagePngBase64,
      kind: input.kind,
      status: "pending",
      createdAt: new Date(),
    })
    .returning();

  return mapRow(inserted[0]!);
}

/** @deprecated Prefer createBotBrandRequest */
export async function createBotAvatarRequest(input: {
  guildId: string;
  requesterId: string;
  requestChannelId: string;
  avatarPngBase64: string;
}): Promise<BotAvatarRequest> {
  return createBotBrandRequest({
    guildId: input.guildId,
    requesterId: input.requesterId,
    requestChannelId: input.requestChannelId,
    imagePngBase64: input.avatarPngBase64,
    kind: "avatar",
  });
}

export async function cancelPendingBotBrandRequest(
  guildId: string,
  kind: BotBrandImageKind,
  cancelledBy: string,
): Promise<BotAvatarRequest | null> {
  const updated = await getDb()
    .update(botAvatarRequests)
    .set({
      status: "cancelled",
      reviewerId: cancelledBy,
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(botAvatarRequests.guildId, guildId),
        eq(botAvatarRequests.status, "pending"),
        eq(botAvatarRequests.kind, kind),
      ),
    )
    .returning();
  return updated[0] ? mapRow(updated[0]) : null;
}

export async function cancelBotBrandRequestById(
  id: number,
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
    .where(
      and(
        eq(botAvatarRequests.id, id),
        eq(botAvatarRequests.guildId, guildId),
        eq(botAvatarRequests.status, "pending"),
      ),
    )
    .returning();
  return updated[0] ? mapRow(updated[0]) : null;
}

/** @deprecated Prefer cancelPendingBotBrandRequest */
export async function cancelPendingBotAvatarRequest(
  guildId: string,
  cancelledBy: string,
): Promise<BotAvatarRequest | null> {
  return cancelPendingBotBrandRequest(guildId, "avatar", cancelledBy);
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

export async function getStoredBotBio(guildId: string): Promise<string | null> {
  const rows = await getDb()
    .select()
    .from(botGuildProfiles)
    .where(eq(botGuildProfiles.guildId, guildId))
    .limit(1);
  return rows[0]?.bio ?? null;
}

export async function setStoredBotBio(
  guildId: string,
  bio: string | null,
  updatedBy: string,
): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(botGuildProfiles)
    .values({
      guildId,
      bio,
      updatedAt: now,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: botGuildProfiles.guildId,
      set: {
        bio,
        updatedAt: now,
        updatedBy,
      },
    });
}

export type StoredBrandImage =
  | { state: "unknown" }
  | { state: "cleared" }
  | { state: "custom"; png: string };

export async function getStoredBrandImage(
  guildId: string,
  kind: BotBrandImageKind,
): Promise<StoredBrandImage> {
  const rows = await getDb()
    .select()
    .from(botGuildProfiles)
    .where(eq(botGuildProfiles.guildId, guildId))
    .limit(1);
  const value = kind === "banner" ? rows[0]?.bannerPng : rows[0]?.avatarPng;
  if (value == null) return { state: "unknown" };
  if (value === "") return { state: "cleared" };
  return { state: "custom", png: value };
}

/** Empty string means the guild image was cleared; do not fall back to old approvals. */
export async function setStoredBrandImage(
  guildId: string,
  kind: BotBrandImageKind,
  pngBase64: string,
  updatedBy: string,
): Promise<void> {
  const now = new Date();
  const patch = kind === "banner" ? { bannerPng: pngBase64 } : { avatarPng: pngBase64 };
  await getDb()
    .insert(botGuildProfiles)
    .values({
      guildId,
      bio: null,
      ...patch,
      updatedAt: now,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: botGuildProfiles.guildId,
      set: {
        ...patch,
        updatedAt: now,
        updatedBy,
      },
    });
}
