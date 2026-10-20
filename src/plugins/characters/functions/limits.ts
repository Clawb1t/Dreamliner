import {
  CHARACTERS_FREE_DAILY_REPLIES,
  CHARACTERS_FREE_LIMIT,
  CHARACTERS_ONE_DAILY_REPLIES,
  CHARACTERS_ONE_LIMIT,
} from "../../../config/schemas/characters.js";
import { isDreamlinerOneActive } from "../../../bridge/dreamlinerOne.js";
import { capMap } from "../../../core/mapPrune.js";
import { getUsage, refundUsage, takeUsage, usageDay } from "./store.js";

/**
 * Characters limits: 2 characters and 100 replies a day for free, 25 and 3000 with Dreamliner
 * One (per UTC day, per server). Members can also be held to a cooldown and a daily cap.
 */

export const FREE_CHARACTERS = CHARACTERS_FREE_LIMIT;
export const FREE_DAILY_REPLIES = CHARACTERS_FREE_DAILY_REPLIES;
export const ONE_CHARACTERS = CHARACTERS_ONE_LIMIT;
export const ONE_DAILY_REPLIES = CHARACTERS_ONE_DAILY_REPLIES;

export function characterLimit(oneActive: boolean): number {
  return oneActive ? ONE_CHARACTERS : FREE_CHARACTERS;
}

export function dailyReplyLimit(oneActive: boolean): number {
  return oneActive ? ONE_DAILY_REPLIES : FREE_DAILY_REPLIES;
}

const ONE_CACHE_MS = 5 * 60_000;
/** Checking One can mean a Discord API call for servers without it; per message that's too much. */
const oneCache = new Map<string, { active: boolean; at: number }>();

export async function guildHasOne(guildId: string): Promise<boolean> {
  const cached = oneCache.get(guildId);
  if (cached && Date.now() - cached.at < ONE_CACHE_MS) return cached.active;
  const active = await isDreamlinerOneActive(guildId).catch(() => false);
  oneCache.delete(guildId);
  oneCache.set(guildId, { active, at: Date.now() });
  capMap(oneCache, 5000);
  return active;
}

/** Takes one of today's character replies; false when the server is out for the day. */
export function takeReply(guildId: string, oneActive: boolean): boolean {
  return takeUsage(guildId, dailyReplyLimit(oneActive));
}

export function refundReply(guildId: string): void {
  refundUsage(guildId);
}

export function usageToday(guildId: string, oneActive: boolean): {
  today: number;
  dailyLimit: number;
  characterLimit: number;
  oneActive: boolean;
} {
  return {
    today: getUsage(guildId).replies,
    dailyLimit: dailyReplyLimit(oneActive),
    characterLimit: characterLimit(oneActive),
    oneActive,
  };
}

// --- Per-member limits (in memory: a restart forgives a cooldown, which is fine) ------------

const lastReply = new Map<string, number>();
const memberDaily = new Map<string, number>();

export type MemberLimitResult = "ok" | "cooldown" | "daily";

/** Whether `userId` may get a reply from `characterId` now. Doesn't count anything. */
export function checkMemberLimits(
  guildId: string,
  userId: string,
  characterId: number,
  limits: { cooldownSeconds: number; dailyLimit: number },
  now = Date.now(),
): MemberLimitResult {
  if (limits.dailyLimit > 0) {
    const used = memberDaily.get(`${guildId}:${userId}:${usageDay(new Date(now))}`) ?? 0;
    if (used >= limits.dailyLimit) return "daily";
  }
  if (limits.cooldownSeconds > 0) {
    const last = lastReply.get(`${guildId}:${userId}:${characterId}`);
    if (last !== undefined && now - last < limits.cooldownSeconds * 1000) return "cooldown";
  }
  return "ok";
}

/** Counts a reply against the member's cooldown and daily cap. */
export function noteMemberReply(guildId: string, userId: string, characterId: number, now = Date.now()): void {
  const cooldownKey = `${guildId}:${userId}:${characterId}`;
  lastReply.delete(cooldownKey);
  lastReply.set(cooldownKey, now);
  capMap(lastReply, 20_000);
  const dayKey = `${guildId}:${userId}:${usageDay(new Date(now))}`;
  const used = memberDaily.get(dayKey) ?? 0;
  memberDaily.delete(dayKey);
  memberDaily.set(dayKey, used + 1);
  capMap(memberDaily, 20_000);
}

/** Test helper: forget every member cooldown/daily count. */
export function resetMemberLimitsForTests(): void {
  lastReply.clear();
  memberDaily.clear();
}
