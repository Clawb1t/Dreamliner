/**
 * Creating and editing giveaways from any input (the dashboard, /giveaway start, /giveaway edit):
 * every value is checked and clamped here, and anything not given comes from the server's
 * Giveaways defaults. Channel and role ids must belong to this server.
 */
import type { Guild } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zGiveawaysConfig, type GiveawaysConfig } from "../../../config/schemas/giveaways.js";
import { zPersistEmbedConfig, type PersistEmbedConfig } from "../../../config/schemas/persist.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";
import { refreshGiveawayMessage, startGiveaway } from "./lifecycle.js";
import { isRecurrence, type GiveawayRecurrence } from "./recurrence.js";
import * as store from "./store.js";
import type { BonusRoleWeight, Giveaway, GiveawayButtonStyle, GiveawayEntryMethod, GiveawayPatch, GiveawayRequireRoleMode } from "./store.js";

export const LIMITS = {
  winners: 50,
  bonusRoles: 25,
  bonusWeight: 100,
  ageDays: 3650,
  messages: 1_000_000,
  claimMinutes: 10_080,
  maxDurationMs: 90 * 86_400_000,
  minDurationMs: 60_000,
  sponsor: 120,
  prize: 256,
  title: 256,
  entryCost: 1_000_000,
  winBonus: 10_000,
} as const;

const SNOWFLAKE = /^\d{15,22}$/;
const BUTTON_STYLES: GiveawayButtonStyle[] = ["primary", "secondary", "success", "danger"];

/** Everything optional except channel and prize; the rest falls back to the server defaults. */
export type CreateGiveawayInput = {
  channelId: string;
  title?: string;
  prize: string;
  entryMethod?: GiveawayEntryMethod;
  reactionEmoji?: string;
  buttonLabel?: string;
  buttonEmoji?: string;
  buttonStyle?: GiveawayButtonStyle;
  embed?: PersistEmbedConfig;
  winnerCount?: number;
  requireRoleIds?: string[];
  requireRoleMode?: GiveawayRequireRoleMode;
  blacklistRoleIds?: string[];
  bypassRoleIds?: string[];
  minAccountAgeDays?: number;
  minJoinAgeDays?: number;
  minMessages?: number;
  requirePassport?: boolean;
  bonusRoleWeights?: BonusRoleWeight[];
  boosterBonusWeight?: number;
  entryCost?: number;
  winBonus?: number;
  pingRoleId?: string | null;
  hostId?: string | null;
  sponsor?: string;
  dmWinner?: boolean;
  dmNonWinners?: boolean;
  claimWindowMinutes?: number;
  recurrence?: GiveawayRecurrence;
  startsAt?: string | null;
  endsAt?: string | null;
  durationMinutes?: number;
};

export async function getGiveawaysConfig(guildId: string): Promise<GiveawaysConfig> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  const parsed = zGiveawaysConfig.safeParse(getPluginSettings(guildConfig, "giveaways"));
  return parsed.success ? parsed.data : zGiveawaysConfig.parse({});
}

/** "1d12h", "90m", "2w", "45" (minutes). Null when it can't be read. */
export function parseDurationText(input: string): number | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 60_000;
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  let total = 0;
  let consumed = "";
  for (const match of raw.matchAll(/(\d+)(s|m|h|d|w)/g)) {
    total += Number(match[1]) * units[match[2]!]!;
    consumed += match[0];
  }
  return consumed === raw && total > 0 ? total : null;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 1000) / 1000)) : fallback;
}

function roleIds(guild: Guild, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((v): v is string => typeof v === "string" && SNOWFLAKE.test(v) && v !== guild.id);
  // Roles not cached (rare) are kept, so a slow cache never silently drops a requirement.
  return [...new Set(ids)].filter((id) => guild.roles.cache.size === 0 || guild.roles.cache.has(id)).slice(0, 25);
}

function bonusRoles(guild: Guild, value: unknown): BonusRoleWeight[] {
  if (!Array.isArray(value)) return [];
  const out: BonusRoleWeight[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const roleId = (raw as { roleId?: unknown }).roleId;
    if (typeof roleId !== "string" || !roleIds(guild, [roleId]).length || out.some((b) => b.roleId === roleId)) continue;
    out.push({ roleId, weight: num((raw as { weight?: unknown }).weight, 1, 0, LIMITS.bonusWeight) });
  }
  return out.slice(0, LIMITS.bonusRoles);
}

function optionalRole(guild: Guild, value: unknown): string | null {
  return typeof value === "string" && roleIds(guild, [value]).length ? value : null;
}

function parseEmbed(value: unknown, fallback: PersistEmbedConfig): PersistEmbedConfig {
  if (value === undefined) return fallback;
  const parsed = zPersistEmbedConfig.safeParse(value);
  return parsed.success ? { ...parsed.data, enabled: true } : fallback;
}

function parseDate(value: string | null | undefined): Date | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function createGiveawayFromInput(
  guild: Guild,
  actorId: string,
  input: CreateGiveawayInput,
): Promise<{ giveaway: Giveaway } | { error: string }> {
  const prize = cleanText(input.prize, LIMITS.prize);
  if (!prize) return { error: "Say what the winner gets (the prize)." };
  if (!input.channelId?.trim()) return { error: "Pick a channel to post the giveaway in." };
  if (!(await fetchGuildTextChannel(guild.client, guild.id, input.channelId))) return { error: "Pick a text channel in this server that Dreamliner can post in." };
  if (input.buttonStyle !== undefined && !BUTTON_STYLES.includes(input.buttonStyle)) return { error: "That button colour isn't valid." };
  if (input.recurrence !== undefined && !isRecurrence(input.recurrence)) return { error: "Repeat must be none, daily or weekly." };

  const config = await getGiveawaysConfig(guild.id);
  const now = new Date();
  const start = parseDate(input.startsAt);
  if (start === "invalid") return { error: "The start time isn't a valid date." };
  const startsAt = start && start.getTime() > now.getTime() ? start : now;

  const end = parseDate(input.endsAt);
  if (end === "invalid") return { error: "The end time isn't a valid date." };
  let endsAt: Date;
  if (end) endsAt = end;
  else if (input.durationMinutes && input.durationMinutes > 0) endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
  else return { error: "Set when the giveaway ends." };
  const duration = endsAt.getTime() - startsAt.getTime();
  if (duration < LIMITS.minDurationMs) return { error: "The giveaway has to run for at least a minute." };
  if (duration > LIMITS.maxDurationMs) return { error: "A giveaway can run for 90 days at most." };

  const created = await store.createGiveaway({
    guildId: guild.id,
    channelId: input.channelId,
    title: cleanText(input.title, LIMITS.title) || prize,
    prize,
    entryMethod: input.entryMethod === "reaction" || input.entryMethod === "button" ? input.entryMethod : config.default_entry_method,
    reactionEmoji: cleanText(input.reactionEmoji, 128) || config.default_reaction_emoji,
    buttonLabel: cleanText(input.buttonLabel, 80) || config.default_button_label || "Enter",
    buttonEmoji: input.buttonEmoji !== undefined ? cleanText(input.buttonEmoji, 128) : config.default_button_emoji,
    buttonStyle: input.buttonStyle ?? config.default_button_style,
    embedConfig: parseEmbed(input.embed, { ...config.default_embed, enabled: true }),
    winnerCount: int(input.winnerCount, config.default_winner_count, 1, LIMITS.winners),
    requireRoleIds: roleIds(guild, input.requireRoleIds),
    requireRoleMode: input.requireRoleMode === "all" || input.requireRoleMode === "any" ? input.requireRoleMode : config.default_require_role_mode,
    blacklistRoleIds: roleIds(guild, input.blacklistRoleIds),
    bypassRoleIds: roleIds(guild, input.bypassRoleIds),
    minAccountAgeDays: int(input.minAccountAgeDays, config.default_min_account_age_days, 0, LIMITS.ageDays),
    minJoinAgeDays: int(input.minJoinAgeDays, 0, 0, LIMITS.ageDays),
    minMessages: int(input.minMessages, 0, 0, LIMITS.messages),
    requirePassport: typeof input.requirePassport === "boolean" ? input.requirePassport : config.default_require_passport,
    bonusRoleWeights: bonusRoles(guild, input.bonusRoleWeights),
    boosterBonusWeight: num(input.boosterBonusWeight, config.default_booster_bonus_weight, 0, LIMITS.bonusWeight),
    entryCost: num(input.entryCost, config.default_entry_cost, 0, LIMITS.entryCost),
    winBonus: num(input.winBonus, config.default_win_bonus, 0, LIMITS.winBonus),
    pingRoleId: input.pingRoleId !== undefined ? optionalRole(guild, input.pingRoleId) : optionalRole(guild, config.ping_role_id),
    hostId: typeof input.hostId === "string" && SNOWFLAKE.test(input.hostId) ? input.hostId : null,
    sponsor: cleanText(input.sponsor, LIMITS.sponsor),
    dmWinner: typeof input.dmWinner === "boolean" ? input.dmWinner : config.default_dm_winner,
    dmNonWinners: typeof input.dmNonWinners === "boolean" ? input.dmNonWinners : config.default_dm_non_winners,
    claimWindowMinutes: int(input.claimWindowMinutes, config.default_claim_window_minutes, 0, LIMITS.claimMinutes),
    recurrence: input.recurrence ?? "none",
    startsAt,
    endsAt,
    createdBy: actorId,
    messageFormat: "v2",
  });
  await store.addEvent(created.id, "created", actorId).catch(() => null);

  // Starting now posts straight away; a later start is posted by the scheduler.
  if (startsAt.getTime() <= Date.now()) {
    const posted = await startGiveaway(guild, created);
    if (posted) return { giveaway: posted };
    const fresh = await store.getGiveaway(guild.id, created.id);
    return { giveaway: fresh ?? created };
  }
  return { giveaway: created };
}

const LABELS: Partial<Record<keyof GiveawayPatch, string>> = {
  prize: "prize",
  title: "title",
  embedConfig: "message",
  buttonLabel: "button",
  buttonEmoji: "button",
  buttonStyle: "button",
  winnerCount: "winners",
  endsAt: "end time",
  startsAt: "start time",
  requireRoleIds: "requirements",
  requireRoleMode: "requirements",
  blacklistRoleIds: "requirements",
  bypassRoleIds: "requirements",
  minAccountAgeDays: "requirements",
  minJoinAgeDays: "requirements",
  minMessages: "requirements",
  requirePassport: "requirements",
  bonusRoleWeights: "bonus entries",
  boosterBonusWeight: "bonus entries",
  entryCost: "entry cost",
  winBonus: "win bonus",
  channelId: "channel",
  pingRoleId: "ping role",
  hostId: "host",
  sponsor: "sponsor",
  recurrence: "repeat",
  claimWindowMinutes: "claim window",
  dmWinner: "DMs",
  dmNonWinners: "DMs",
  entryMethod: "entry method",
  reactionEmoji: "entry method",
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Edits a giveaway that hasn't ended. The channel can only change before it's posted. Changes to
 * requirements and bonuses apply to new entries; existing entries keep their entries.
 */
export async function editGiveawayFromInput(
  guild: Guild,
  existing: Giveaway,
  patch: Partial<CreateGiveawayInput>,
  actorId: string,
): Promise<{ giveaway: Giveaway } | { error: string }> {
  if (existing.status === "ended" || existing.status === "ending" || existing.status === "cancelled") {
    return { error: `This giveaway is ${existing.status === "ending" ? "ending" : existing.status}, so it can't be edited.` };
  }
  const out: GiveawayPatch = {};

  if (patch.channelId !== undefined && patch.channelId !== existing.channelId) {
    if (existing.messageId) return { error: "The channel can't change after the giveaway is posted." };
    if (!(await fetchGuildTextChannel(guild.client, guild.id, patch.channelId))) return { error: "Pick a text channel in this server that Dreamliner can post in." };
    out.channelId = patch.channelId;
  }
  if (patch.prize !== undefined) {
    const prize = cleanText(patch.prize, LIMITS.prize);
    if (!prize) return { error: "The prize can't be empty." };
    out.prize = prize;
  }
  if (patch.title !== undefined) out.title = cleanText(patch.title, LIMITS.title) || out.prize || existing.prize;
  if (patch.buttonStyle !== undefined) {
    if (!BUTTON_STYLES.includes(patch.buttonStyle)) return { error: "That button colour isn't valid." };
    out.buttonStyle = patch.buttonStyle;
  }
  if (patch.recurrence !== undefined) {
    if (!isRecurrence(patch.recurrence)) return { error: "Repeat must be none, daily or weekly." };
    out.recurrence = patch.recurrence;
  }
  if (patch.entryMethod !== undefined && patch.entryMethod !== existing.entryMethod) {
    if (existing.messageId) return { error: "The entry method can't change after the giveaway is posted." };
    if (patch.entryMethod !== "button" && patch.entryMethod !== "reaction") return { error: "Entry must be a button or a reaction." };
    out.entryMethod = patch.entryMethod;
  }
  if (patch.reactionEmoji !== undefined && !existing.messageId) out.reactionEmoji = cleanText(patch.reactionEmoji, 128) || existing.reactionEmoji;
  if (patch.buttonLabel !== undefined) out.buttonLabel = cleanText(patch.buttonLabel, 80) || "Enter";
  if (patch.buttonEmoji !== undefined) out.buttonEmoji = cleanText(patch.buttonEmoji, 128);
  if (patch.embed !== undefined) out.embedConfig = parseEmbed(patch.embed, existing.embedConfig);
  if (patch.winnerCount !== undefined) out.winnerCount = int(patch.winnerCount, existing.winnerCount, 1, LIMITS.winners);
  if (patch.requireRoleIds !== undefined) out.requireRoleIds = roleIds(guild, patch.requireRoleIds);
  if (patch.requireRoleMode !== undefined) out.requireRoleMode = patch.requireRoleMode === "all" ? "all" : "any";
  if (patch.blacklistRoleIds !== undefined) out.blacklistRoleIds = roleIds(guild, patch.blacklistRoleIds);
  if (patch.bypassRoleIds !== undefined) out.bypassRoleIds = roleIds(guild, patch.bypassRoleIds);
  if (patch.minAccountAgeDays !== undefined) out.minAccountAgeDays = int(patch.minAccountAgeDays, existing.minAccountAgeDays, 0, LIMITS.ageDays);
  if (patch.minJoinAgeDays !== undefined) out.minJoinAgeDays = int(patch.minJoinAgeDays, existing.minJoinAgeDays, 0, LIMITS.ageDays);
  if (patch.minMessages !== undefined) out.minMessages = int(patch.minMessages, existing.minMessages, 0, LIMITS.messages);
  if (typeof patch.requirePassport === "boolean") out.requirePassport = patch.requirePassport;
  if (patch.bonusRoleWeights !== undefined) out.bonusRoleWeights = bonusRoles(guild, patch.bonusRoleWeights);
  if (patch.boosterBonusWeight !== undefined) out.boosterBonusWeight = num(patch.boosterBonusWeight, existing.boosterBonusWeight, 0, LIMITS.bonusWeight);
  if (patch.entryCost !== undefined) out.entryCost = num(patch.entryCost, existing.entryCost, 0, LIMITS.entryCost);
  if (patch.winBonus !== undefined) out.winBonus = num(patch.winBonus, existing.winBonus, 0, LIMITS.winBonus);
  if (patch.pingRoleId !== undefined) out.pingRoleId = optionalRole(guild, patch.pingRoleId);
  if (patch.hostId !== undefined) out.hostId = typeof patch.hostId === "string" && SNOWFLAKE.test(patch.hostId) ? patch.hostId : null;
  if (patch.sponsor !== undefined) out.sponsor = cleanText(patch.sponsor, LIMITS.sponsor);
  if (typeof patch.dmWinner === "boolean") out.dmWinner = patch.dmWinner;
  if (typeof patch.dmNonWinners === "boolean") out.dmNonWinners = patch.dmNonWinners;
  if (patch.claimWindowMinutes !== undefined) out.claimWindowMinutes = int(patch.claimWindowMinutes, existing.claimWindowMinutes, 0, LIMITS.claimMinutes);

  let startsAt = existing.startsAt;
  if (patch.startsAt !== undefined && existing.status === "scheduled") {
    const parsed = parseDate(patch.startsAt);
    if (parsed === "invalid") return { error: "The start time isn't a valid date." };
    startsAt = parsed && parsed.getTime() > Date.now() ? parsed : new Date();
    out.startsAt = startsAt;
  }
  let endsAt = existing.endsAt;
  if (patch.endsAt !== undefined && patch.endsAt !== null) {
    const parsed = parseDate(patch.endsAt);
    if (parsed === "invalid" || parsed === null) return { error: "The end time isn't a valid date." };
    endsAt = parsed;
  } else if (patch.durationMinutes !== undefined && patch.durationMinutes > 0) {
    endsAt = new Date(startsAt.getTime() + patch.durationMinutes * 60_000);
  }
  if (endsAt.getTime() !== existing.endsAt.getTime() || out.startsAt) {
    const from = existing.status === "scheduled" ? startsAt.getTime() : Date.now();
    if (endsAt.getTime() - from < LIMITS.minDurationMs) return { error: "The end time has to be at least a minute from now." };
    if (endsAt.getTime() - startsAt.getTime() > LIMITS.maxDurationMs) return { error: "A giveaway can run for 90 days at most." };
    out.endsAt = endsAt;
  }

  const changedKeys = (Object.keys(out) as (keyof GiveawayPatch)[]).filter((k) => !sameValue(out[k], existing[k as keyof Giveaway]));
  if (!changedKeys.length) return { giveaway: existing };

  const updated = await store.transitionGiveaway(existing.id, ["scheduled", "active", "paused"], out);
  if (!updated) return { error: "This giveaway ended while you were editing it." };

  const changed = [...new Set(changedKeys.map((k) => LABELS[k]).filter(Boolean))];
  await store.addEvent(updated.id, "edited", actorId, changed.length ? `Changed ${changed.join(", ")}` : null).catch(() => null);
  if (updated.messageId) await refreshGiveawayMessage(guild, updated);
  return { giveaway: updated };
}
