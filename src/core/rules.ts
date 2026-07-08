import type { GuildMember, Message } from "discord.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import { getMemberLevel } from "./permissions.js";

export type RuleContext = {
  message: Message;
  member: GuildMember | null;
  guildConfig: GuildConfig;
};

export type ChannelRuleFilter = {
  channels?: string[];
  categories?: string[];
  ignored_channels?: string[];
  ignored_categories?: string[];
  min_level?: number;
  max_level?: number;
};

export function messageMatchesChannelRule(ctx: RuleContext, filter: ChannelRuleFilter): boolean {
  const channel = ctx.message.channel;
  if (!channel.isTextBased()) return false;

  const channelId = channel.id;
  const categoryId = "parentId" in channel ? channel.parentId : null;

  if (filter.ignored_channels?.includes(channelId)) return false;
  if (categoryId && filter.ignored_categories?.includes(categoryId)) return false;
  if (filter.channels?.length && !filter.channels.includes(channelId)) return false;
  if (filter.categories?.length && (!categoryId || !filter.categories.includes(categoryId))) return false;

  if (filter.min_level !== undefined || filter.max_level !== undefined) {
    if (!ctx.member) return false;
    const level = getMemberLevel(ctx.member, ctx.guildConfig.levels);
    if (filter.min_level !== undefined && level < filter.min_level) return false;
    if (filter.max_level !== undefined && level > filter.max_level) return false;
  }

  return true;
}

export function contentMatchesPattern(content: string, pattern: string, regex = false, caseSensitive = false): boolean {
  if (!pattern) return false;
  if (regex) {
    try {
      return new RegExp(pattern, caseSensitive ? "" : "i").test(content);
    } catch {
      return false;
    }
  }
  const hay = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return hay.includes(needle);
}

export type RateLimitState = {
  timestamps: number[];
};

const rateBuckets = new Map<string, RateLimitState>();

export function checkRateLimit(key: string, maxCount: number, windowMs: number): boolean {
  const now = Date.now();
  const state = rateBuckets.get(key) ?? { timestamps: [] };
  state.timestamps = state.timestamps.filter((t) => now - t < windowMs);
  if (state.timestamps.length >= maxCount) {
    rateBuckets.set(key, state);
    return true;
  }
  state.timestamps.push(now);
  rateBuckets.set(key, state);
  return false;
}

export function clearRateLimit(key: string): void {
  rateBuckets.delete(key);
}
