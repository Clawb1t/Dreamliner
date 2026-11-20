import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, sql, sum } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  giveawayBlacklist,
  giveawayDraws,
  giveawayEntries,
  giveawayEvents,
  giveawayTemplates,
  giveawayWinners,
  giveaways,
} from "../../../db/schema.js";
import { zPersistEmbedConfig, type PersistEmbedConfig } from "../../../config/schemas/persist.js";
import type { TicketButtonStyle } from "../../../config/schemas/tickets.js";
import type { GiveawayRecurrence } from "./recurrence.js";

export type GiveawayStatus = "scheduled" | "active" | "ending" | "ended" | "cancelled" | "paused";
export type GiveawayEntryMethod = "button" | "reaction";
export type GiveawayRequireRoleMode = "any" | "all";
export type GiveawayButtonStyle = TicketButtonStyle;
export type WinnerStatus = "won" | "claimed" | "expired_unclaimed" | "rerolled";
export type GiveawayMessageFormat = "embed" | "v2";
export type DrawKind = "draw" | "reroll" | "auto_reroll";
export type GiveawayEventKind =
  | "created"
  | "started"
  | "paused"
  | "resumed"
  | "extended"
  | "edited"
  | "ended"
  | "rerolled"
  | "claimed"
  | "cancelled"
  | "entrant_removed"
  | "error";

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
  requirePassport: boolean;
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
  minMessages: number;
  hostId: string | null;
  sponsor: string;
  recurrence: GiveawayRecurrence;
  recurrenceParentId: number | null;
  recurrenceNextId: number | null;
  messageFormat: GiveawayMessageFormat;
  announceMessageId: string | null;
  lastError: string | null;
  cancelledAt: Date | null;
};

export type GiveawayEntry = { giveawayId: number; userId: string; weight: number; enteredAt: Date; paid: number };

export type GiveawayWinner = {
  id: number;
  giveawayId: number;
  userId: string;
  status: WinnerStatus;
  selectedAt: Date;
  claimedAt: Date | null;
  rerolledAt: Date | null;
  replacesWinnerId: number | null;
  drawId: number | null;
};

export type GiveawayDraw = {
  id: number;
  giveawayId: number;
  kind: DrawKind;
  seed: string | null;
  poolHash: string | null;
  poolSize: number;
  totalWeight: number;
  pickedUserIds: string[];
  replacedUserIds: string[];
  actorId: string | null;
  createdAt: Date;
};

export type GiveawayEvent = {
  id: number;
  giveawayId: number;
  kind: GiveawayEventKind;
  actorId: string | null;
  detail: string | null;
  createdAt: Date;
};

export type GiveawayBlacklistEntry = {
  guildId: string;
  userId: string;
  reason: string | null;
  createdBy: string;
  createdAt: Date;
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
    requirePassport: row.requirePassport,
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
    minMessages: row.minMessages ?? 0,
    hostId: row.hostId ?? null,
    sponsor: row.sponsor ?? "",
    recurrence: row.recurrence === "daily" || row.recurrence === "weekly" ? row.recurrence : "none",
    recurrenceParentId: row.recurrenceParentId ?? null,
    recurrenceNextId: row.recurrenceNextId ?? null,
    messageFormat: row.messageFormat === "v2" ? "v2" : "embed",
    announceMessageId: row.announceMessageId ?? null,
    lastError: row.lastError ?? null,
    cancelledAt: row.cancelledAt ?? null,
  };
}

function mapEntry(row: typeof giveawayEntries.$inferSelect): GiveawayEntry {
  return { giveawayId: row.giveawayId, userId: row.userId, weight: row.weight, enteredAt: row.enteredAt, paid: row.paid ?? 0 };
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
    drawId: row.drawId ?? null,
  };
}

function mapDraw(row: typeof giveawayDraws.$inferSelect): GiveawayDraw {
  return {
    id: row.id,
    giveawayId: row.giveawayId,
    kind: row.kind === "reroll" || row.kind === "auto_reroll" ? row.kind : "draw",
    seed: row.seed,
    poolHash: row.poolHash,
    poolSize: row.poolSize,
    totalWeight: row.totalWeight,
    pickedUserIds: safeJsonArray<string>(row.pickedUserIds),
    replacedUserIds: safeJsonArray<string>(row.replacedUserIds),
    actorId: row.actorId,
    createdAt: row.createdAt,
  };
}

function mapEvent(row: typeof giveawayEvents.$inferSelect): GiveawayEvent {
  return {
    id: row.id,
    giveawayId: row.giveawayId,
    kind: row.kind as GiveawayEventKind,
    actorId: row.actorId,
    detail: row.detail,
    createdAt: row.createdAt,
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
  requirePassport?: boolean;
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
  minMessages?: number;
  hostId?: string | null;
  sponsor?: string;
  recurrence?: GiveawayRecurrence;
  recurrenceParentId?: number | null;
  /** New giveaways post as Components V2; only rows from before 0150 are "embed". */
  messageFormat?: GiveawayMessageFormat;
};

export type GiveawayPatch = Partial<NewGiveawayInput> & {
  messageId?: string | null;
  status?: GiveawayStatus;
  pausedAt?: Date | null;
  endedAt?: Date | null;
  announceMessageId?: string | null;
  lastError?: string | null;
  cancelledAt?: Date | null;
};

const JSON_PATCH_KEYS = new Set(["requireRoleIds", "blacklistRoleIds", "bypassRoleIds", "bonusRoleWeights", "embedConfig"]);
const PATCH_KEYS = [
  "channelId",
  "title",
  "prize",
  "status",
  "entryMethod",
  "reactionEmoji",
  "buttonLabel",
  "buttonEmoji",
  "buttonStyle",
  "embedConfig",
  "winnerCount",
  "requireRoleIds",
  "requireRoleMode",
  "blacklistRoleIds",
  "bypassRoleIds",
  "minAccountAgeDays",
  "minJoinAgeDays",
  "requirePassport",
  "bonusRoleWeights",
  "boosterBonusWeight",
  "entryCost",
  "winBonus",
  "pingRoleId",
  "dmWinner",
  "dmNonWinners",
  "claimWindowMinutes",
  "startsAt",
  "endsAt",
  "messageId",
  "pausedAt",
  "endedAt",
  "minMessages",
  "hostId",
  "sponsor",
  "recurrence",
  "messageFormat",
  "announceMessageId",
  "lastError",
  "cancelledAt",
] as const;

function patchToRow(patch: GiveawayPatch): Partial<typeof giveaways.$inferInsert> {
  const row: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    row[key] = JSON_PATCH_KEYS.has(key) ? JSON.stringify(value) : value;
  }
  return row as Partial<typeof giveaways.$inferInsert>;
}

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
      requirePassport: input.requirePassport ?? false,
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
      minMessages: input.minMessages ?? 0,
      hostId: input.hostId ?? null,
      sponsor: input.sponsor ?? "",
      recurrence: input.recurrence ?? "none",
      recurrenceParentId: input.recurrenceParentId ?? null,
      messageFormat: input.messageFormat ?? "v2",
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
    .set({ ...patchToRow(patch), updatedAt: new Date() })
    .where(eq(giveaways.id, id))
    .returning()
    .get();
  return row ? mapGiveaway(row) : null;
}

/** Status change only while the row is still in one of `from` (race guard for pause/resume/cancel). */
export async function transitionGiveaway(id: number, from: GiveawayStatus[], patch: GiveawayPatch): Promise<Giveaway | null> {
  const row = await getDb()
    .update(giveaways)
    .set({ ...patchToRow(patch), updatedAt: new Date() })
    .where(and(eq(giveaways.id, id), inArray(giveaways.status, from)))
    .returning()
    .get();
  return row ? mapGiveaway(row) : null;
}

export async function deleteGiveaway(id: number): Promise<void> {
  const db = getDb();
  await db.delete(giveawayWinners).where(eq(giveawayWinners.giveawayId, id));
  await db.delete(giveawayEntries).where(eq(giveawayEntries.giveawayId, id));
  await db.delete(giveawayDraws).where(eq(giveawayDraws.giveawayId, id));
  await db.delete(giveawayEvents).where(eq(giveawayEvents.giveawayId, id));
  // Other occurrences of a recurring giveaway stop pointing at the deleted one.
  await db.update(giveaways).set({ recurrenceParentId: null }).where(eq(giveaways.recurrenceParentId, id));
  await db.delete(giveaways).where(eq(giveaways.id, id));
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

export async function getGiveawayByMessageId(guildId: string, messageId: string): Promise<Giveaway | null> {
  const row = await getDb()
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.guildId, guildId), eq(giveaways.messageId, messageId)))
    .get();
  return row ? mapGiveaway(row) : null;
}

/**
 * Race guard for ending: a conditional UPDATE that only affects a row still "active" or "paused".
 * Empty means another tick (or a dashboard action) already claimed this giveaway.
 */
export async function claimGiveawayForEnding(id: number): Promise<Giveaway | null> {
  const row = await getDb()
    .update(giveaways)
    .set({ status: "ending", pausedAt: null, updatedAt: new Date() })
    .where(and(eq(giveaways.id, id), inArray(giveaways.status, ["active", "paused"])))
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

// -- Entries -------------------------------------------------------------------------------------

export async function addEntry(input: { giveawayId: number; userId: string; weight: number; paid?: number }): Promise<GiveawayEntry> {
  const row = await getDb()
    .insert(giveawayEntries)
    .values({
      giveawayId: input.giveawayId,
      userId: input.userId,
      weight: input.weight,
      enteredAt: new Date(),
      paid: input.paid ?? 0,
    })
    .onConflictDoUpdate({
      target: [giveawayEntries.giveawayId, giveawayEntries.userId],
      set: { weight: input.weight },
    })
    .returning()
    .get();
  return mapEntry(row);
}

/** Removes an entry and returns it (null when they weren't entered). */
export async function removeEntry(giveawayId: number, userId: string): Promise<GiveawayEntry | null> {
  const row = await getDb()
    .delete(giveawayEntries)
    .where(and(eq(giveawayEntries.giveawayId, giveawayId), eq(giveawayEntries.userId, userId)))
    .returning()
    .get();
  return row ? mapEntry(row) : null;
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
  const rows = await getDb()
    .select()
    .from(giveawayEntries)
    .where(eq(giveawayEntries.giveawayId, giveawayId))
    .orderBy(asc(giveawayEntries.enteredAt))
    .all();
  return rows.map(mapEntry);
}

export async function getEntryCount(giveawayId: number): Promise<number> {
  const row = await getDb().select({ n: count() }).from(giveawayEntries).where(eq(giveawayEntries.giveawayId, giveawayId)).get();
  return row?.n ?? 0;
}

/** Entrants, total weight and how many got bonus entries (weight above 1). */
export async function getEntryStats(giveawayId: number): Promise<{ entrants: number; totalWeight: number; bonusEntrants: number }> {
  const row = await getDb()
    .select({
      n: count(),
      total: sum(giveawayEntries.weight),
      bonus: sql<number>`sum(case when ${giveawayEntries.weight} > 1 then 1 else 0 end)`,
    })
    .from(giveawayEntries)
    .where(eq(giveawayEntries.giveawayId, giveawayId))
    .get();
  return { entrants: row?.n ?? 0, totalWeight: Number(row?.total ?? 0) || 0, bonusEntrants: Number(row?.bonus ?? 0) || 0 };
}

/** Entry counts for many giveaways at once (the list page). */
export async function getEntryCounts(giveawayIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!giveawayIds.length) return out;
  const rows = await getDb()
    .select({ id: giveawayEntries.giveawayId, n: count() })
    .from(giveawayEntries)
    .where(inArray(giveawayEntries.giveawayId, giveawayIds))
    .groupBy(giveawayEntries.giveawayId)
    .all();
  for (const row of rows) out.set(row.id, row.n);
  return out;
}

// -- Winners -------------------------------------------------------------------------------------

/** Marks a winner claimed only while they're still "won" (so a claim can't be paid twice). */
export async function claimWinnerRow(id: number, claimedAt: Date): Promise<boolean> {
  const rows = await getDb()
    .update(giveawayWinners)
    .set({ status: "claimed", claimedAt })
    .where(and(eq(giveawayWinners.id, id), eq(giveawayWinners.status, "won")))
    .returning();
  return rows.length > 0;
}

/** Retires a winner row (reroll or expiry) only while it's still current. False if it already changed. */
export async function retireWinnerRow(id: number, status: WinnerStatus, at: Date, from: WinnerStatus[] = ["won", "claimed"]): Promise<boolean> {
  const rows = await getDb()
    .update(giveawayWinners)
    .set({ status, rerolledAt: at })
    .where(and(eq(giveawayWinners.id, id), inArray(giveawayWinners.status, from)))
    .returning();
  return rows.length > 0;
}

export async function listWinners(giveawayId: number): Promise<GiveawayWinner[]> {
  const rows = await getDb()
    .select()
    .from(giveawayWinners)
    .where(eq(giveawayWinners.giveawayId, giveawayId))
    .orderBy(asc(giveawayWinners.id))
    .all();
  return rows.map(mapWinner);
}

export async function listWinnersByStatus(giveawayId: number, status: WinnerStatus): Promise<GiveawayWinner[]> {
  return (await listWinners(giveawayId)).filter((w) => w.status === status);
}

/** Winners still holding a prize (unclaimed or claimed). */
export async function listCurrentWinners(giveawayId: number): Promise<GiveawayWinner[]> {
  return (await listWinners(giveawayId)).filter((w) => w.status === "won" || w.status === "claimed");
}

/** Winner rows for many giveaways at once (the list page). */
export async function listWinnersFor(giveawayIds: number[]): Promise<GiveawayWinner[]> {
  if (!giveawayIds.length) return [];
  const rows = await getDb().select().from(giveawayWinners).where(inArray(giveawayWinners.giveawayId, giveawayIds)).all();
  return rows.map(mapWinner);
}

// -- Draws ---------------------------------------------------------------------------------------

export type NewDrawInput = {
  giveawayId: number;
  kind: DrawKind;
  seed: string | null;
  poolHash: string | null;
  poolSize: number;
  totalWeight: number;
  pickedUserIds: string[];
  replacedUserIds?: string[];
  actorId?: string | null;
};

/**
 * Records a draw and its winners in one transaction. For kind "draw" the partial unique index
 * (one draw per giveaway) makes a second attempt fail, and this returns null instead of drawing
 * twice. `replaces` maps a picked user to the winner row they replace (rerolls).
 */
export function recordDraw(
  input: NewDrawInput,
  options: { selectedAt?: Date; replaces?: Map<string, number | null> } = {},
): { draw: GiveawayDraw; winners: GiveawayWinner[] } | null {
  const now = options.selectedAt ?? new Date();
  try {
    return getDb().transaction((tx) => {
      const drawRow = tx
        .insert(giveawayDraws)
        .values({
          giveawayId: input.giveawayId,
          kind: input.kind,
          seed: input.seed,
          poolHash: input.poolHash,
          poolSize: input.poolSize,
          totalWeight: input.totalWeight,
          pickedUserIds: JSON.stringify(input.pickedUserIds),
          replacedUserIds: JSON.stringify(input.replacedUserIds ?? []),
          actorId: input.actorId ?? null,
          createdAt: now,
        })
        .returning()
        .get();
      const winners = input.pickedUserIds.map((userId) =>
        tx
          .insert(giveawayWinners)
          .values({
            giveawayId: input.giveawayId,
            userId,
            status: "won",
            selectedAt: now,
            replacesWinnerId: options.replaces?.get(userId) ?? null,
            drawId: drawRow.id,
          })
          .returning()
          .get(),
      );
      return { draw: mapDraw(drawRow), winners: winners.map(mapWinner) };
    });
  } catch (error) {
    if (input.kind === "draw" && /UNIQUE constraint failed/i.test(String((error as Error)?.message ?? error))) return null;
    throw error;
  }
}

export async function getInitialDraw(giveawayId: number): Promise<GiveawayDraw | null> {
  const row = await getDb()
    .select()
    .from(giveawayDraws)
    .where(and(eq(giveawayDraws.giveawayId, giveawayId), eq(giveawayDraws.kind, "draw")))
    .get();
  return row ? mapDraw(row) : null;
}

export async function listDraws(giveawayId: number): Promise<GiveawayDraw[]> {
  const rows = await getDb()
    .select()
    .from(giveawayDraws)
    .where(eq(giveawayDraws.giveawayId, giveawayId))
    .orderBy(asc(giveawayDraws.id))
    .all();
  return rows.map(mapDraw);
}

// -- Timeline ------------------------------------------------------------------------------------

export async function addEvent(
  giveawayId: number,
  kind: GiveawayEventKind,
  actorId: string | null = null,
  detail: string | null = null,
): Promise<void> {
  await getDb()
    .insert(giveawayEvents)
    .values({ giveawayId, kind, actorId, detail: detail ? detail.slice(0, 500) : null, createdAt: new Date() })
    .run();
}

export async function listEvents(giveawayId: number, limit = 200): Promise<GiveawayEvent[]> {
  const rows = await getDb()
    .select()
    .from(giveawayEvents)
    .where(eq(giveawayEvents.giveawayId, giveawayId))
    .orderBy(desc(giveawayEvents.id))
    .limit(limit)
    .all();
  return rows.map(mapEvent).reverse();
}

// -- Blacklist -----------------------------------------------------------------------------------

export async function isBlacklisted(guildId: string, userId: string): Promise<boolean> {
  const row = await getDb()
    .select({ userId: giveawayBlacklist.userId })
    .from(giveawayBlacklist)
    .where(and(eq(giveawayBlacklist.guildId, guildId), eq(giveawayBlacklist.userId, userId)))
    .get();
  return Boolean(row);
}

export async function addToBlacklist(input: { guildId: string; userId: string; reason?: string | null; createdBy: string }): Promise<void> {
  const reason = input.reason?.trim().slice(0, 300) || null;
  await getDb()
    .insert(giveawayBlacklist)
    .values({ guildId: input.guildId, userId: input.userId, reason, createdBy: input.createdBy, createdAt: new Date() })
    .onConflictDoUpdate({ target: [giveawayBlacklist.guildId, giveawayBlacklist.userId], set: { reason } })
    .run();
}

export async function removeFromBlacklist(guildId: string, userId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(giveawayBlacklist)
    .where(and(eq(giveawayBlacklist.guildId, guildId), eq(giveawayBlacklist.userId, userId)))
    .returning();
  return rows.length > 0;
}

export async function listBlacklist(guildId: string): Promise<GiveawayBlacklistEntry[]> {
  const rows = await getDb()
    .select()
    .from(giveawayBlacklist)
    .where(eq(giveawayBlacklist.guildId, guildId))
    .orderBy(desc(giveawayBlacklist.createdAt))
    .all();
  return rows.map((r) => ({ guildId: r.guildId, userId: r.userId, reason: r.reason, createdBy: r.createdBy, createdAt: r.createdAt }));
}

// -- Recurrence and recovery ---------------------------------------------------------------------

/** Links a giveaway to its next occurrence, only if it has none yet. False means it already had one. */
export async function linkNextOccurrence(id: number, nextId: number): Promise<boolean> {
  const rows = await getDb()
    .update(giveaways)
    .set({ recurrenceNextId: nextId })
    .where(and(eq(giveaways.id, id), isNull(giveaways.recurrenceNextId)))
    .returning();
  return rows.length > 0;
}

/** Giveaways left in "ending" (the bot stopped mid-end) for longer than `olderThan`. */
export async function getStuckEnding(olderThan: Date): Promise<Giveaway[]> {
  const rows = await getDb()
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.status, "ending"), lt(giveaways.updatedAt, olderThan)))
    .all();
  return rows.map(mapGiveaway);
}

/** Ended recurring giveaways whose next occurrence was never scheduled (e.g. a restart mid-end). */
export async function getRecurringWithoutNext(): Promise<Giveaway[]> {
  const rows = await getDb()
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.status, "ended"), inArray(giveaways.recurrence, ["daily", "weekly"]), isNull(giveaways.recurrenceNextId)))
    .all();
  return rows.map(mapGiveaway);
}

// -- Templates -----------------------------------------------------------------------------------

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

export async function deleteTemplate(guildId: string, id: number): Promise<void> {
  await getDb()
    .delete(giveawayTemplates)
    .where(and(eq(giveawayTemplates.guildId, guildId), eq(giveawayTemplates.id, id)));
}
