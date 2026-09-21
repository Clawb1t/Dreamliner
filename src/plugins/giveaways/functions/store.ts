import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { giveawayEntries, giveawayTemplates, giveawayWinners, giveaways } from "../../../db/schema.js";
import { zPersistEmbedConfig, type PersistEmbedConfig } from "../../../config/schemas/persist.js";
import type { TicketButtonStyle } from "../../../config/schemas/tickets.js";

export type GiveawayStatus = "scheduled" | "active" | "ending" | "ended" | "cancelled" | "paused";
export type GiveawayEntryMethod = "button" | "reaction";
export type GiveawayRequireRoleMode = "any" | "all";
export type GiveawayButtonStyle = TicketButtonStyle;
export type WinnerStatus = "won" | "claimed" | "expired_unclaimed" | "rerolled";

export type BonusRoleWeight = { roleId: string; weight: number };

export type Giveaway = {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  title: string;
  prize: string;
  status: GiveawayStatus;
  entryMethod: GiveawayEntryMethod;
  reactionEmoji: string;
  buttonLabel: string;
  buttonEmoji: string;
  buttonStyle: GiveawayButtonStyle;
  embedConfig: PersistEmbedConfig;
  winnerCount: number;
  requireRoleIds: string[];
  requireRoleMode: GiveawayRequireRoleMode;
  blacklistRoleIds: string[];
  bypassRoleIds: string[];
  minAccountAgeDays: number;
  minJoinAgeDays: number;
  bonusRoleWeights: BonusRoleWeight[];
  boosterBonusWeight: number;
  entryCost: number;
  winBonus: number;
  pingRoleId: string | null;
  dmWinner: boolean;
  dmNonWinners: boolean;
  claimWindowMinutes: number;
  startsAt: Date;
  endsAt: Date;
  pausedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
};

export type GiveawayEntry = { giveawayId: number; userId: string; weight: number; enteredAt: Date };

export type GiveawayWinner = {
  id: number;
  giveawayId: number;
  userId: string;
  status: WinnerStatus;
  selectedAt: Date;
  claimedAt: Date | null;
  rerolledAt: Date | null;
  replacesWinnerId: number | null;
};

export type GiveawayTemplate = {
  id: number;
  guildId: string;
  name: string;
  settings: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
};

function safeJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeEmbedConfig(raw: string): PersistEmbedConfig {
  try {
    return zPersistEmbedConfig.parse(JSON.parse(raw));
  } catch {
    return zPersistEmbedConfig.parse({});
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapGiveaway(row: typeof giveaways.$inferSelect): Giveaway {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    title: row.title,
    prize: row.prize,
    status: row.status as GiveawayStatus,
    entryMethod: row.entryMethod as GiveawayEntryMethod,
    reactionEmoji: row.reactionEmoji,
    buttonLabel: row.buttonLabel,
    buttonEmoji: row.buttonEmoji,
    buttonStyle: row.buttonStyle as GiveawayButtonStyle,
    embedConfig: safeEmbedConfig(row.embedConfig),
    winnerCount: row.winnerCount,
    requireRoleIds: safeJsonArray<string>(row.requireRoleIds),
    requireRoleMode: row.requireRoleMode as GiveawayRequireRoleMode,
    blacklistRoleIds: safeJsonArray<string>(row.blacklistRoleIds),
    bypassRoleIds: safeJsonArray<string>(row.bypassRoleIds),
    minAccountAgeDays: row.minAccountAgeDays,
    minJoinAgeDays: row.minJoinAgeDays,
    bonusRoleWeights: safeJsonArray<BonusRoleWeight>(row.bonusRoleWeights),
    boosterBonusWeight: row.boosterBonusWeight,
    entryCost: row.entryCost,
    winBonus: row.winBonus,
    pingRoleId: row.pingRoleId,
    dmWinner: row.dmWinner,
    dmNonWinners: row.dmNonWinners,
    claimWindowMinutes: row.claimWindowMinutes,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    pausedAt: row.pausedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
  };
}

function mapEntry(row: typeof giveawayEntries.$inferSelect): GiveawayEntry {
  return { giveawayId: row.giveawayId, userId: row.userId, weight: row.weight, enteredAt: row.enteredAt };
}

function mapWinner(row: typeof giveawayWinners.$inferSelect): GiveawayWinner {
  return {
    id: row.id,
    giveawayId: row.giveawayId,
    userId: row.userId,
    status: row.status as WinnerStatus,
    selectedAt: row.selectedAt,
    claimedAt: row.claimedAt,
    rerolledAt: row.rerolledAt,
    replacesWinnerId: row.replacesWinnerId,
  };
}

function mapTemplate(row: typeof giveawayTemplates.$inferSelect): GiveawayTemplate {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    settings: safeJsonObject(row.settings),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export type NewGiveawayInput = {
  guildId: string;
  channelId: string;
  title: string;
  prize: string;
  status?: GiveawayStatus;
  entryMethod: GiveawayEntryMethod;
  reactionEmoji: string;
  buttonLabel: string;
  buttonEmoji: string;
  buttonStyle: GiveawayButtonStyle;
  embedConfig: PersistEmbedConfig;
  winnerCount: number;
  requireRoleIds: string[];
  requireRoleMode: GiveawayRequireRoleMode;
  blacklistRoleIds: string[];
  bypassRoleIds: string[];
  minAccountAgeDays: number;
  minJoinAgeDays: number;
  bonusRoleWeights: BonusRoleWeight[];
  boosterBonusWeight: number;
  entryCost: number;
  winBonus: number;
  pingRoleId?: string | null;
  dmWinner: boolean;
  dmNonWinners: boolean;
  claimWindowMinutes: number;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
};

export type GiveawayPatch = Partial<NewGiveawayInput> & {
  messageId?: string | null;
  status?: GiveawayStatus;
  pausedAt?: Date | null;
  endedAt?: Date | null;
};

export async function createGiveaway(input: NewGiveawayInput): Promise<Giveaway> {
  const now = new Date();
  const row = await getDb()
    .insert(giveaways)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      title: input.title,
      prize: input.prize,
      status: input.status ?? "scheduled",
      entryMethod: input.entryMethod,
      reactionEmoji: input.reactionEmoji,
      buttonLabel: input.buttonLabel,
      buttonEmoji: input.buttonEmoji,
      buttonStyle: input.buttonStyle,
      embedConfig: JSON.stringify(input.embedConfig),
      winnerCount: input.winnerCount,
      requireRoleIds: JSON.stringify(input.requireRoleIds),
      requireRoleMode: input.requireRoleMode,
      blacklistRoleIds: JSON.stringify(input.blacklistRoleIds),
      bypassRoleIds: JSON.stringify(input.bypassRoleIds),
      minAccountAgeDays: input.minAccountAgeDays,
      minJoinAgeDays: input.minJoinAgeDays,
      bonusRoleWeights: JSON.stringify(input.bonusRoleWeights),
      boosterBonusWeight: input.boosterBonusWeight,
      entryCost: input.entryCost,
      winBonus: input.winBonus,
      pingRoleId: input.pingRoleId ?? null,
      dmWinner: input.dmWinner,
      dmNonWinners: input.dmNonWinners,
      claimWindowMinutes: input.claimWindowMinutes,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return mapGiveaway(row);
}

export async function getGiveaway(guildId: string, id: number): Promise<Giveaway | null> {
  const row = await getDb()
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id)))
    .get();
  return row ? mapGiveaway(row) : null;
}

export async function listGiveaways(
  guildId: string,
  filters?: { status?: GiveawayStatus | GiveawayStatus[] },
): Promise<Giveaway[]> {
  const conditions = [eq(giveaways.guildId, guildId)];
  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    conditions.push(inArray(giveaways.status, statuses));
  }
  const rows = await getDb()
    .select()
    .from(giveaways)
    .where(and(...conditions))
    .all();
  return rows.map(mapGiveaway);
}

export async function updateGiveaway(id: number, patch: GiveawayPatch): Promise<Giveaway | null> {
  const row = await getDb()
    .update(giveaways)
    .set({
      ...(patch.channelId !== undefined ? { channelId: patch.channelId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.prize !== undefined ? { prize: patch.prize } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.entryMethod !== undefined ? { entryMethod: patch.entryMethod } : {}),
      ...(patch.reactionEmoji !== undefined ? { reactionEmoji: patch.reactionEmoji } : {}),
      ...(patch.buttonLabel !== undefined ? { buttonLabel: patch.buttonLabel } : {}),
      ...(patch.buttonEmoji !== undefined ? { buttonEmoji: patch.buttonEmoji } : {}),
      ...(patch.buttonStyle !== undefined ? { buttonStyle: patch.buttonStyle } : {}),
      ...(patch.embedConfig !== undefined ? { embedConfig: JSON.stringify(patch.embedConfig) } : {}),
      ...(patch.winnerCount !== undefined ? { winnerCount: patch.winnerCount } : {}),
      ...(patch.requireRoleIds !== undefined ? { requireRoleIds: JSON.stringify(patch.requireRoleIds) } : {}),
      ...(patch.requireRoleMode !== undefined ? { requireRoleMode: patch.requireRoleMode } : {}),
      ...(patch.blacklistRoleIds !== undefined ? { blacklistRoleIds: JSON.stringify(patch.blacklistRoleIds) } : {}),
      ...(patch.bypassRoleIds !== undefined ? { bypassRoleIds: JSON.stringify(patch.bypassRoleIds) } : {}),
      ...(patch.minAccountAgeDays !== undefined ? { minAccountAgeDays: patch.minAccountAgeDays } : {}),
      ...(patch.minJoinAgeDays !== undefined ? { minJoinAgeDays: patch.minJoinAgeDays } : {}),
      ...(patch.bonusRoleWeights !== undefined ? { bonusRoleWeights: JSON.stringify(patch.bonusRoleWeights) } : {}),
      ...(patch.boosterBonusWeight !== undefined ? { boosterBonusWeight: patch.boosterBonusWeight } : {}),
      ...(patch.entryCost !== undefined ? { entryCost: patch.entryCost } : {}),
      ...(patch.winBonus !== undefined ? { winBonus: patch.winBonus } : {}),
      ...(patch.pingRoleId !== undefined ? { pingRoleId: patch.pingRoleId } : {}),
      ...(patch.dmWinner !== undefined ? { dmWinner: patch.dmWinner } : {}),
      ...(patch.dmNonWinners !== undefined ? { dmNonWinners: patch.dmNonWinners } : {}),
      ...(patch.claimWindowMinutes !== undefined ? { claimWindowMinutes: patch.claimWindowMinutes } : {}),
      ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
      ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
      ...(patch.messageId !== undefined ? { messageId: patch.messageId } : {}),
      ...(patch.pausedAt !== undefined ? { pausedAt: patch.pausedAt } : {}),
      ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(giveaways.id, id))
    .returning()
    .get();
  return row ? mapGiveaway(row) : null;
}

export async function deleteGiveaway(id: number): Promise<void> {
  await getDb().delete(giveawayWinners).where(eq(giveawayWinners.giveawayId, id));
  await getDb().delete(giveawayEntries).where(eq(giveawayEntries.giveawayId, id));
  await getDb().delete(giveaways).where(eq(giveaways.id, id));
}

export async function getDueGiveaways(now: Date): Promise<Giveaway[]> {
  const rows = await getDb()
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.status, "active"), lte(giveaways.endsAt, now)))
    .all();
  return rows.map(mapGiveaway);
}

export async function getGiveawaysDueToStart(now: Date): Promise<Giveaway[]> {
  const rows = await getDb()
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.status, "scheduled"), lte(giveaways.startsAt, now)))
    .all();
  return rows.map(mapGiveaway);
}

export async function setGiveawayMessageId(id: number, messageId: string): Promise<void> {
  await getDb().update(giveaways).set({ messageId, updatedAt: new Date() }).where(eq(giveaways.id, id));
}

export async function getGiveawayByMessageId(guildId: string, messageId: string): Promise<Giveaway | null> {
  const row = await getDb()
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.guildId, guildId), eq(giveaways.messageId, messageId)))
    .get();
  return row ? mapGiveaway(row) : null;
}

/**
 * Race guard for the active -> ending transition: a conditional UPDATE that only affects a row
 * still in "active" status. `.returning()` comes back empty when nothing matched, which is the
 * signal that another tick (or a dashboard action) already claimed this giveaway. See
 * bot_customisation/functions/store.ts's resolveBotAvatarRequest for the same pattern.
 */
export async function claimGiveawayForEnding(id: number): Promise<Giveaway | null> {
  const row = await getDb()
    .update(giveaways)
    .set({ status: "ending", updatedAt: new Date() })
    .where(and(eq(giveaways.id, id), eq(giveaways.status, "active")))
    .returning()
    .get();
  return row ? mapGiveaway(row) : null;
}

export async function getGiveawaysWithExpiredClaims(now: Date): Promise<Giveaway[]> {
  const candidates = await getDb()
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.status, "ended"), gt(giveaways.claimWindowMinutes, 0)))
    .all();
  if (!candidates.length) return [];

  const ids = candidates.map((c) => c.id);
  const wonWinners = await getDb()
    .select()
    .from(giveawayWinners)
    .where(and(inArray(giveawayWinners.giveawayId, ids), eq(giveawayWinners.status, "won")))
    .all();

  const nowMs = now.getTime();
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const expiredGiveawayIds = new Set(
    wonWinners
      .filter((w) => {
        const giveaway = byId.get(w.giveawayId);
        if (!giveaway) return false;
        return w.selectedAt.getTime() + giveaway.claimWindowMinutes * 60_000 <= nowMs;
      })
      .map((w) => w.giveawayId),
  );

  return candidates.filter((c) => expiredGiveawayIds.has(c.id)).map(mapGiveaway);
}

export async function addEntry(input: { giveawayId: number; userId: string; weight: number }): Promise<GiveawayEntry> {
  const row = await getDb()
    .insert(giveawayEntries)
    .values({
      giveawayId: input.giveawayId,
      userId: input.userId,
      weight: input.weight,
      enteredAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [giveawayEntries.giveawayId, giveawayEntries.userId],
      set: { weight: input.weight },
    })
    .returning()
    .get();
  return mapEntry(row);
}

export async function removeEntry(giveawayId: number, userId: string): Promise<boolean> {
  const row = await getDb()
    .delete(giveawayEntries)
    .where(and(eq(giveawayEntries.giveawayId, giveawayId), eq(giveawayEntries.userId, userId)))
    .returning()
    .get();
  return Boolean(row);
}

export async function getEntry(giveawayId: number, userId: string): Promise<GiveawayEntry | null> {
  const row = await getDb()
    .select()
    .from(giveawayEntries)
    .where(and(eq(giveawayEntries.giveawayId, giveawayId), eq(giveawayEntries.userId, userId)))
    .get();
  return row ? mapEntry(row) : null;
}

export async function listEntries(giveawayId: number): Promise<GiveawayEntry[]> {
  const rows = await getDb().select().from(giveawayEntries).where(eq(giveawayEntries.giveawayId, giveawayId)).all();
  return rows.map(mapEntry);
}

export async function getEntryCount(giveawayId: number): Promise<number> {
  return (await listEntries(giveawayId)).length;
}

export async function insertWinner(input: {
  giveawayId: number;
  userId: string;
  status?: WinnerStatus;
  selectedAt: Date;
  replacesWinnerId?: number | null;
}): Promise<GiveawayWinner> {
  const row = await getDb()
    .insert(giveawayWinners)
    .values({
      giveawayId: input.giveawayId,
      userId: input.userId,
      status: input.status ?? "won",
      selectedAt: input.selectedAt,
      replacesWinnerId: input.replacesWinnerId ?? null,
    })
    .returning()
    .get();
  return mapWinner(row);
}

export async function updateWinner(
  id: number,
  patch: Partial<{ status: WinnerStatus; claimedAt: Date | null; rerolledAt: Date | null }>,
): Promise<GiveawayWinner | null> {
  const row = await getDb()
    .update(giveawayWinners)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.claimedAt !== undefined ? { claimedAt: patch.claimedAt } : {}),
      ...(patch.rerolledAt !== undefined ? { rerolledAt: patch.rerolledAt } : {}),
    })
    .where(eq(giveawayWinners.id, id))
    .returning()
    .get();
  return row ? mapWinner(row) : null;
}

export async function listWinners(giveawayId: number): Promise<GiveawayWinner[]> {
  const rows = await getDb().select().from(giveawayWinners).where(eq(giveawayWinners.giveawayId, giveawayId)).all();
  return rows.map(mapWinner);
}

export async function listWinnersByStatus(giveawayId: number, status: WinnerStatus): Promise<GiveawayWinner[]> {
  const rows = await getDb()
    .select()
    .from(giveawayWinners)
    .where(and(eq(giveawayWinners.giveawayId, giveawayId), eq(giveawayWinners.status, status)))
    .all();
  return rows.map(mapWinner);
}

export async function listTemplates(guildId: string): Promise<GiveawayTemplate[]> {
  const rows = await getDb().select().from(giveawayTemplates).where(eq(giveawayTemplates.guildId, guildId)).all();
  return rows.map(mapTemplate);
}

export async function createTemplate(input: {
  guildId: string;
  name: string;
  settings: Record<string, unknown>;
  createdBy: string;
}): Promise<GiveawayTemplate> {
  const row = await getDb()
    .insert(giveawayTemplates)
    .values({
      guildId: input.guildId,
      name: input.name,
      settings: JSON.stringify(input.settings),
      createdBy: input.createdBy,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return mapTemplate(row);
}

export async function deleteTemplate(id: number): Promise<void> {
  await getDb().delete(giveawayTemplates).where(eq(giveawayTemplates.id, id));
}
