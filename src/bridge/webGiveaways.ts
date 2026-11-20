import type { Client, Guild } from "discord.js";
import { zPersistEmbedConfig, type PersistEmbedConfig } from "../config/schemas/persist.js";
import * as store from "../plugins/giveaways/functions/store.js";
import type {
  BonusRoleWeight,
  Giveaway,
  GiveawayButtonStyle,
  GiveawayEntryMethod,
  GiveawayRequireRoleMode,
  GiveawayStatus,
  GiveawayTemplate,
  WinnerStatus,
} from "../plugins/giveaways/functions/store.js";
import { createGiveawayFromInput, editGiveawayFromInput, type CreateGiveawayInput } from "../plugins/giveaways/functions/create.js";
import {
  cancelGiveaway,
  deleteGiveawayFully,
  endGiveawayNow,
  extendGiveaway,
  pauseGiveaway,
  removeEntrant,
  rerollGiveaway,
  resumeGiveaway,
  type ActionResult,
} from "../plugins/giveaways/functions/lifecycle.js";
import { buildLiveV2, messageUrl } from "../plugins/giveaways/functions/message.js";
import { claimDeadline } from "../plugins/giveaways/functions/draw.js";
import type { GiveawayRecurrence } from "../plugins/giveaways/functions/recurrence.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";

export type { CreateGiveawayInput } from "../plugins/giveaways/functions/create.js";

export type WebPerson = { id: string; name: string; username: string | null; avatar: string | null };

export type WebGiveawayWinner = {
  id: number;
  userId: string;
  person: WebPerson;
  status: WinnerStatus;
  selectedAt: string;
  claimedAt: string | null;
  claimDeadline: string | null;
  replacesWinnerId: number | null;
};

/** One row on the list page. */
export type WebGiveawayRow = {
  id: number;
  title: string;
  prize: string;
  status: GiveawayStatus;
  channelId: string;
  messageId: string | null;
  messageUrl: string | null;
  startsAt: string;
  endsAt: string;
  endedAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  winnerCount: number;
  entryCount: number;
  winners: { userId: string; status: WinnerStatus }[];
  recurrence: GiveawayRecurrence;
  hostId: string | null;
  imageUrl: string | null;
  lastError: string | null;
};

/** The full giveaway, for the detail page and the editor. */
export type WebGiveaway = WebGiveawayRow & {
  entryMethod: GiveawayEntryMethod;
  reactionEmoji: string;
  buttonLabel: string;
  buttonEmoji: string;
  buttonStyle: GiveawayButtonStyle;
  embed: PersistEmbedConfig;
  requireRoleIds: string[];
  requireRoleMode: GiveawayRequireRoleMode;
  blacklistRoleIds: string[];
  bypassRoleIds: string[];
  minAccountAgeDays: number;
  minJoinAgeDays: number;
  minMessages: number;
  requirePassport: boolean;
  bonusRoleWeights: BonusRoleWeight[];
  boosterBonusWeight: number;
  entryCost: number;
  winBonus: number;
  pingRoleId: string | null;
  sponsor: string;
  dmWinner: boolean;
  dmNonWinners: boolean;
  claimWindowMinutes: number;
  createdBy: string;
  updatedAt: string;
  cancelledAt: string | null;
  recurrenceParentId: number | null;
  recurrenceNextId: number | null;
  messageFormat: "embed" | "v2";
};

export type WebGiveawayDraw = {
  id: number;
  kind: "draw" | "reroll" | "auto_reroll";
  seed: string | null;
  poolHash: string | null;
  poolSize: number;
  totalWeight: number;
  picked: WebPerson[];
  replaced: WebPerson[];
  actor: WebPerson | null;
  createdAt: string;
};

export type WebGiveawayEvent = { id: number; kind: string; actor: WebPerson | null; detail: string | null; createdAt: string };

export type WebGiveawayStats = {
  total: number;
  byStatus: Record<"scheduled" | "active" | "paused" | "ended" | "cancelled", number>;
  endedThisMonth: number;
  totalEntries: number;
  runningEntries: number;
  winnersDrawn: number;
  claimed: number;
  recurring: number;
};

export type WebGiveawayTemplate = { id: number; name: string; settings: Record<string, unknown>; createdBy: string; createdAt: string };

const ENTRANTS_MAX_LIMIT = 100;

function iso(value: Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoOr(value: Date | null | undefined): string {
  return iso(value) ?? new Date(0).toISOString();
}

async function resolvePerson(guild: Guild, userId: string): Promise<WebPerson> {
  const member = await fetchMemberCached(guild, userId);
  const user = member?.user ?? (await fetchUserCached(guild.client, userId));
  return {
    id: userId,
    name: member?.displayName ?? user?.globalName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

async function people(guild: Guild, ids: (string | null | undefined)[]): Promise<Map<string, WebPerson>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id && /^\d{15,22}$/.test(id))))];
  const resolved = await Promise.all(unique.map((id) => resolvePerson(guild, id)));
  return new Map(resolved.map((p) => [p.id, p]));
}

function unknownPerson(id: string): WebPerson {
  return { id, name: id, username: null, avatar: null };
}

function toRow(g: Giveaway, entryCount: number, winners: store.GiveawayWinner[]): WebGiveawayRow {
  return {
    id: g.id,
    title: g.title,
    prize: g.prize,
    status: g.status,
    channelId: g.channelId,
    messageId: g.messageId,
    messageUrl: messageUrl(g),
    startsAt: isoOr(g.startsAt),
    endsAt: isoOr(g.endsAt),
    endedAt: iso(g.endedAt),
    pausedAt: iso(g.pausedAt),
    createdAt: isoOr(g.createdAt),
    winnerCount: g.winnerCount,
    entryCount,
    winners: winners.filter((w) => w.status === "won" || w.status === "claimed").map((w) => ({ userId: w.userId, status: w.status })),
    recurrence: g.recurrence,
    hostId: g.hostId,
    imageUrl: g.embedConfig.image_url || null,
    lastError: g.lastError,
  };
}

function toFull(g: Giveaway, entryCount: number, winners: store.GiveawayWinner[]): WebGiveaway {
  return {
    ...toRow(g, entryCount, winners),
    entryMethod: g.entryMethod,
    reactionEmoji: g.reactionEmoji,
    buttonLabel: g.buttonLabel,
    buttonEmoji: g.buttonEmoji,
    buttonStyle: g.buttonStyle,
    embed: g.embedConfig,
    requireRoleIds: g.requireRoleIds,
    requireRoleMode: g.requireRoleMode,
    blacklistRoleIds: g.blacklistRoleIds,
    bypassRoleIds: g.bypassRoleIds,
    minAccountAgeDays: g.minAccountAgeDays,
    minJoinAgeDays: g.minJoinAgeDays,
    minMessages: g.minMessages,
    requirePassport: g.requirePassport,
    bonusRoleWeights: g.bonusRoleWeights,
    boosterBonusWeight: g.boosterBonusWeight,
    entryCost: g.entryCost,
    winBonus: g.winBonus,
    pingRoleId: g.pingRoleId,
    sponsor: g.sponsor,
    dmWinner: g.dmWinner,
    dmNonWinners: g.dmNonWinners,
    claimWindowMinutes: g.claimWindowMinutes,
    createdBy: g.createdBy,
    updatedAt: isoOr(g.updatedAt),
    cancelledAt: iso(g.cancelledAt),
    recurrenceParentId: g.recurrenceParentId,
    recurrenceNextId: g.recurrenceNextId,
    messageFormat: g.messageFormat,
  };
}

async function fullFor(g: Giveaway): Promise<WebGiveaway> {
  const [entryCount, winners] = await Promise.all([store.getEntryCount(g.id), store.listWinners(g.id)]);
  return toFull(g, entryCount, winners);
}

// -- Reads ---------------------------------------------------------------------------------------

export async function listGuildGiveaways(guild: Guild): Promise<{ giveaways: WebGiveawayRow[]; stats: WebGiveawayStats }> {
  const rows = await store.listGiveaways(guild.id);
  const ids = rows.map((r) => r.id);
  const [counts, winners] = await Promise.all([store.getEntryCounts(ids), store.listWinnersFor(ids)]);
  const winnersBy = new Map<number, store.GiveawayWinner[]>();
  for (const w of winners) winnersBy.set(w.giveawayId, [...(winnersBy.get(w.giveawayId) ?? []), w]);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const stats: WebGiveawayStats = {
    total: rows.length,
    byStatus: { scheduled: 0, active: 0, paused: 0, ended: 0, cancelled: 0 },
    endedThisMonth: 0,
    totalEntries: 0,
    runningEntries: 0,
    winnersDrawn: 0,
    claimed: 0,
    recurring: 0,
  };
  for (const g of rows) {
    const status = g.status === "ending" ? "active" : g.status;
    stats.byStatus[status] += 1;
    const n = counts.get(g.id) ?? 0;
    stats.totalEntries += n;
    if (status === "active" || status === "paused") stats.runningEntries += n;
    if (g.status === "ended" && g.endedAt && g.endedAt.getTime() >= monthStart.getTime()) stats.endedThisMonth += 1;
    if (g.recurrence !== "none" && (status === "active" || status === "scheduled" || status === "paused")) stats.recurring += 1;
  }
  for (const w of winners) {
    if (w.status === "won" || w.status === "claimed") stats.winnersDrawn += 1;
    if (w.status === "claimed") stats.claimed += 1;
  }

  const items = rows.map((g) => toRow(g, counts.get(g.id) ?? 0, winnersBy.get(g.id) ?? []));
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { giveaways: items, stats };
}

export type GiveawayDetail = {
  giveaway: WebGiveaway;
  winners: WebGiveawayWinner[];
  draws: WebGiveawayDraw[];
  events: WebGiveawayEvent[];
  stats: { entrants: number; totalWeight: number; bonusEntrants: number; winChance: number | null };
  host: WebPerson | null;
  createdBy: WebPerson | null;
};

export async function getGuildGiveaway(guild: Guild, id: number): Promise<GiveawayDetail | { error: string }> {
  const g = await store.getGiveaway(guild.id, id);
  if (!g) return { error: "Giveaway not found" };
  const [winners, draws, events, stats] = await Promise.all([store.listWinners(g.id), store.listDraws(g.id), store.listEvents(g.id), store.getEntryStats(g.id)]);
  const who = await people(guild, [
    g.hostId,
    g.createdBy,
    ...winners.map((w) => w.userId),
    ...draws.flatMap((d) => [...d.pickedUserIds, ...d.replacedUserIds, d.actorId]),
    ...events.map((e) => e.actorId),
  ]);
  const person = (id: string) => who.get(id) ?? unknownPerson(id);

  return {
    giveaway: toFull(g, stats.entrants, winners),
    winners: winners.map((w) => ({
      id: w.id,
      userId: w.userId,
      person: person(w.userId),
      status: w.status,
      selectedAt: isoOr(w.selectedAt),
      claimedAt: iso(w.claimedAt),
      claimDeadline: w.status === "won" ? iso(claimDeadline(g, w.selectedAt)) : null,
      replacesWinnerId: w.replacesWinnerId,
    })),
    draws: draws.map((d) => ({
      id: d.id,
      kind: d.kind,
      seed: d.seed,
      poolHash: d.poolHash,
      poolSize: d.poolSize,
      totalWeight: d.totalWeight,
      picked: d.pickedUserIds.map(person),
      replaced: d.replacedUserIds.map(person),
      actor: d.actorId ? person(d.actorId) : null,
      createdAt: isoOr(d.createdAt),
    })),
    events: events.map((e) => ({ id: e.id, kind: e.kind, actor: e.actorId ? person(e.actorId) : null, detail: e.detail, createdAt: isoOr(e.createdAt) })),
    stats: {
      ...stats,
      winChance: stats.totalWeight > 0 ? Math.min(1, g.winnerCount / Math.max(1, stats.entrants)) : null,
    },
    host: g.hostId ? person(g.hostId) : null,
    createdBy: /^\d{15,22}$/.test(g.createdBy) ? person(g.createdBy) : null,
  };
}

export type WebGiveawayEntrant = { userId: string; person: WebPerson; weight: number; paid: number; enteredAt: string; isWinner: boolean };

/** Entrants, newest first, searchable by name, username or id, paged. */
export async function listGuildGiveawayEntrants(
  guild: Guild,
  id: number,
  query: { q?: string; offset?: number; limit?: number },
): Promise<{ entrants: WebGiveawayEntrant[]; total: number; totalAll: number } | { error: string }> {
  const g = await store.getGiveaway(guild.id, id);
  if (!g) return { error: "Giveaway not found" };
  const [entries, winners] = await Promise.all([store.listEntries(g.id), store.listCurrentWinners(g.id)]);
  const winnerIds = new Set(winners.map((w) => w.userId));
  const q = (query.q ?? "").trim().toLowerCase().slice(0, 100);
  entries.sort((a, b) => b.enteredAt.getTime() - a.enteredAt.getTime());
  const matching = q
    ? entries.filter((e) => {
        if (e.userId.includes(q)) return true;
        const member = guild.members.cache.get(e.userId);
        const user = member?.user ?? guild.client.users.cache.get(e.userId);
        return [member?.displayName, user?.username, user?.globalName].some((name) => name?.toLowerCase().includes(q));
      })
    : entries;
  const limit = Math.min(ENTRANTS_MAX_LIMIT, Math.max(1, Math.round(query.limit ?? 25) || 25));
  const offset = Math.max(0, Math.round(query.offset ?? 0) || 0);
  const page = matching.slice(offset, offset + limit);
  const who = await people(guild, page.map((e) => e.userId));
  return {
    entrants: page.map((e) => ({
      userId: e.userId,
      person: who.get(e.userId) ?? unknownPerson(e.userId),
      weight: e.weight,
      paid: e.paid,
      enteredAt: isoOr(e.enteredAt),
      isWinner: winnerIds.has(e.userId),
    })),
    total: matching.length,
    totalAll: entries.length,
  };
}

// -- Writes --------------------------------------------------------------------------------------

export async function createGuildGiveaway(guild: Guild, actorId: string, input: CreateGiveawayInput): Promise<{ giveaway: WebGiveaway } | { error: string }> {
  const result = await createGiveawayFromInput(guild, actorId, input ?? ({} as CreateGiveawayInput));
  if ("error" in result) return result;
  return { giveaway: await fullFor(result.giveaway) };
}

export async function updateGuildGiveaway(guild: Guild, id: number, actorId: string, patch: Partial<CreateGiveawayInput>): Promise<{ giveaway: WebGiveaway } | { error: string }> {
  const existing = await store.getGiveaway(guild.id, id);
  if (!existing) return { error: "Giveaway not found" };
  const result = await editGiveawayFromInput(guild, existing, patch ?? {}, actorId);
  if ("error" in result) return result;
  return { giveaway: await fullFor(result.giveaway) };
}

export async function deleteGuildGiveaway(guild: Guild, id: number): Promise<{ ok: true } | { error: string }> {
  const existing = await store.getGiveaway(guild.id, id);
  if (!existing) return { error: "Giveaway not found" };
  if (existing.status === "ending") return { error: "This giveaway is drawing its winners right now. Try again in a moment." };
  await deleteGiveawayFully(guild, existing);
  return { ok: true };
}

export const GIVEAWAY_ACTIONS = ["end", "reroll", "pause", "resume", "cancel", "extend"] as const;
export type GiveawayAction = (typeof GIVEAWAY_ACTIONS)[number];

export async function performGiveawayAction(
  guild: Guild,
  id: number,
  action: GiveawayAction,
  body: { winnerId?: string; winnerIds?: string[]; minutes?: number },
  actorId: string,
): Promise<{ giveaway: WebGiveaway; detail?: string } | { error: string }> {
  const giveaway = await store.getGiveaway(guild.id, id);
  if (!giveaway) return { error: "Giveaway not found" };

  let result: ActionResult & { result?: { newWinnerIds: string[] } };
  let detail: string | undefined;
  switch (action) {
    case "end":
      result = await endGiveawayNow(guild.client, giveaway, actorId);
      break;
    case "pause":
      result = await pauseGiveaway(guild, giveaway, actorId);
      break;
    case "resume":
      result = await resumeGiveaway(guild, giveaway, actorId);
      break;
    case "cancel":
      result = await cancelGiveaway(guild, giveaway, actorId);
      break;
    case "extend":
      result = await extendGiveaway(guild, giveaway, Number(body.minutes), actorId);
      break;
    case "reroll": {
      const ids = Array.isArray(body.winnerIds)
        ? body.winnerIds.filter((v): v is string => typeof v === "string" && /^\d{15,22}$/.test(v)).slice(0, 50)
        : typeof body.winnerId === "string" && body.winnerId
          ? [body.winnerId]
          : null;
      result = await rerollGiveaway(guild.client, giveaway, ids && ids.length ? ids : null, actorId);
      if (result.ok) detail = `${result.result?.newWinnerIds.length ?? 0} new winner(s)`;
      break;
    }
    default:
      return { error: "Unknown action" };
  }
  if (!result.ok) return { error: result.error };
  const fresh = (await store.getGiveaway(guild.id, id)) ?? result.giveaway;
  return { giveaway: await fullFor(fresh), detail };
}

export async function removeGuildGiveawayEntrant(
  guild: Guild,
  id: number,
  userId: string,
  actorId: string,
  body: { blacklist?: boolean; reason?: string },
): Promise<{ ok: true; removed: boolean } | { error: string }> {
  if (!/^\d{15,22}$/.test(userId)) return { error: "Invalid user id" };
  const giveaway = await store.getGiveaway(guild.id, id);
  if (!giveaway) return { error: "Giveaway not found" };
  const result = await removeEntrant(guild, giveaway, userId, {
    blacklist: body.blacklist === true,
    reason: typeof body.reason === "string" ? body.reason : null,
    actorId,
  });
  if (!result.ok) return { error: result.error };
  return { ok: true, removed: result.removed ?? false };
}

// -- Blacklist -----------------------------------------------------------------------------------

export async function listGuildGiveawayBlacklist(guild: Guild): Promise<{ blacklist: { person: WebPerson; reason: string | null; createdBy: WebPerson; createdAt: string }[] }> {
  const rows = await store.listBlacklist(guild.id);
  const who = await people(guild, rows.flatMap((r) => [r.userId, r.createdBy]));
  return {
    blacklist: rows.map((r) => ({
      person: who.get(r.userId) ?? unknownPerson(r.userId),
      reason: r.reason,
      createdBy: who.get(r.createdBy) ?? unknownPerson(r.createdBy),
      createdAt: isoOr(r.createdAt),
    })),
  };
}

export async function addGuildGiveawayBlacklist(guild: Guild, actorId: string, body: { userId?: string; reason?: string }): Promise<{ ok: true } | { error: string }> {
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!/^\d{15,22}$/.test(userId)) return { error: "Pick a member to block." };
  await store.addToBlacklist({ guildId: guild.id, userId, reason: body.reason ?? null, createdBy: actorId });
  return { ok: true };
}

export async function removeGuildGiveawayBlacklist(guild: Guild, userId: string): Promise<{ ok: true } | { error: string }> {
  if (!(await store.removeFromBlacklist(guild.id, userId))) return { error: "That member isn't blocked." };
  return { ok: true };
}

// -- Templates -----------------------------------------------------------------------------------

function toWebTemplate(template: GiveawayTemplate): WebGiveawayTemplate {
  return { id: template.id, name: template.name, settings: template.settings, createdBy: template.createdBy, createdAt: isoOr(template.createdAt) };
}

export async function listGuildGiveawayTemplates(guild: Guild): Promise<{ templates: WebGiveawayTemplate[] }> {
  const rows = await store.listTemplates(guild.id);
  return { templates: rows.map(toWebTemplate) };
}

export async function createGuildGiveawayTemplate(
  guild: Guild,
  actorId: string,
  name: string,
  settings: Record<string, unknown>,
): Promise<{ template: WebGiveawayTemplate } | { error: string }> {
  if (!name.trim()) return { error: "Give the template a name." };
  if ((await store.listTemplates(guild.id)).length >= 50) return { error: "You can keep up to 50 templates. Delete one first." };
  const safe = settings && typeof settings === "object" ? settings : {};
  if (JSON.stringify(safe).length > 20_000) return { error: "That template is too big." };
  const created = await store.createTemplate({ guildId: guild.id, name: name.trim().slice(0, 80), settings: safe, createdBy: actorId });
  return { template: toWebTemplate(created) };
}

export async function deleteGuildGiveawayTemplate(guild: Guild, id: number): Promise<{ ok: true } | { error: string }> {
  const existing = (await store.listTemplates(guild.id)).find((t) => t.id === id);
  if (!existing) return { error: "Template not found" };
  await store.deleteTemplate(guild.id, id);
  return { ok: true };
}

// -- Preview -------------------------------------------------------------------------------------

/**
 * Runs a draft through the real Components V2 builder, so a dashboard can check exactly what gets
 * posted. Lenient: an incomplete draft still renders.
 */
export async function buildGiveawayPreview(_client: Client, guild: Guild, body: unknown): Promise<{ components: unknown[] }> {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const embed = zPersistEmbedConfig.safeParse(raw.embed ?? {});
  const now = new Date();
  const ends = typeof raw.endsAt === "string" && !Number.isNaN(new Date(raw.endsAt).getTime()) ? new Date(raw.endsAt) : new Date(now.getTime() + 3_600_000);
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const nums = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const placeholder: Giveaway = {
    id: 0,
    guildId: guild.id,
    channelId: str(raw.channelId),
    messageId: null,
    title: str(raw.title),
    prize: str(raw.prize, "Prize") || "Prize",
    status: "active",
    entryMethod: raw.entryMethod === "reaction" ? "reaction" : "button",
    reactionEmoji: str(raw.reactionEmoji, "<:icons_gift:1544417552627802212>"),
    buttonLabel: str(raw.buttonLabel, "Enter"),
    buttonEmoji: str(raw.buttonEmoji),
    buttonStyle: (["primary", "secondary", "success", "danger"] as const).includes(raw.buttonStyle as "primary") ? (raw.buttonStyle as GiveawayButtonStyle) : "primary",
    embedConfig: embed.success ? embed.data : zPersistEmbedConfig.parse({}),
    winnerCount: Math.max(1, nums(raw.winnerCount, 1)),
    requireRoleIds: ids(raw.requireRoleIds),
    requireRoleMode: raw.requireRoleMode === "all" ? "all" : "any",
    blacklistRoleIds: ids(raw.blacklistRoleIds),
    bypassRoleIds: [],
    minAccountAgeDays: nums(raw.minAccountAgeDays),
    minJoinAgeDays: nums(raw.minJoinAgeDays),
    requirePassport: raw.requirePassport === true,
    bonusRoleWeights: Array.isArray(raw.bonusRoleWeights) ? (raw.bonusRoleWeights as BonusRoleWeight[]) : [],
    boosterBonusWeight: nums(raw.boosterBonusWeight),
    entryCost: 0,
    winBonus: 0,
    pingRoleId: null,
    dmWinner: true,
    dmNonWinners: false,
    claimWindowMinutes: 0,
    startsAt: now,
    endsAt: ends,
    pausedAt: null,
    createdBy: "preview",
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    minMessages: nums(raw.minMessages),
    hostId: typeof raw.hostId === "string" && raw.hostId ? raw.hostId : null,
    sponsor: str(raw.sponsor),
    recurrence: raw.recurrence === "daily" || raw.recurrence === "weekly" ? raw.recurrence : "none",
    recurrenceParentId: null,
    recurrenceNextId: null,
    messageFormat: "v2",
    announceMessageId: null,
    lastError: null,
    cancelledAt: null,
  };
  const payload = buildLiveV2(placeholder, nums(raw.entryCount), guild);
  return { components: (payload.components ?? []) as unknown[] };
}
