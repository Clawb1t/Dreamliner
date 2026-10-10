import {
  TICKET_AI_FREE_DAILY_BACKGROUND,
  TICKET_AI_FREE_DAILY_REPLIES,
  TICKET_AI_ONE_DAILY_BACKGROUND,
  TICKET_AI_ONE_DAILY_REPLIES,
} from "../../../../config/schemas/ticketAi.js";
import { isDreamlinerOneActive } from "../../../../bridge/dreamlinerOne.js";
import { capMap } from "../../../../core/mapPrune.js";
import { getUsage, refundUsage, takeUsage, usageDay } from "./store.js";

/**
 * Daily limits for the AI Responder: 20 replies a day, or 1000 with Dreamliner One (per UTC day).
 * Background work (Autotrain, learning from staff) has its own smaller budget so it never eats
 * into the replies members see.
 */

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

export function dailyLimits(oneActive: boolean): { replies: number; background: number } {
  return oneActive
    ? { replies: TICKET_AI_ONE_DAILY_REPLIES, background: TICKET_AI_ONE_DAILY_BACKGROUND }
    : { replies: TICKET_AI_FREE_DAILY_REPLIES, background: TICKET_AI_FREE_DAILY_BACKGROUND };
}

/** Start of the next UTC day: when the daily counts reset. */
export function nextResetAt(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export type UsageSummary = {
  oneActive: boolean;
  day: string;
  replies: { used: number; limit: number };
  background: { used: number; limit: number };
  escalations: number;
  resolved: number;
  resetsAt: string;
};

export async function usageSummary(guildId: string): Promise<UsageSummary> {
  const oneActive = await guildHasOne(guildId);
  const limits = dailyLimits(oneActive);
  const day = usageDay();
  const usage = getUsage(guildId, day);
  return {
    oneActive,
    day,
    replies: { used: usage.replies, limit: limits.replies },
    background: { used: usage.background, limit: limits.background },
    escalations: usage.escalations,
    resolved: usage.resolved,
    resetsAt: nextResetAt().toISOString(),
  };
}

/** Takes one of today's replies; false when the server is out for the day. */
export async function takeReply(guildId: string): Promise<boolean> {
  return takeUsage(guildId, "replies", dailyLimits(await guildHasOne(guildId)).replies);
}

export async function takeBackground(guildId: string): Promise<boolean> {
  return takeUsage(guildId, "background", dailyLimits(await guildHasOne(guildId)).background);
}

export { refundUsage };
