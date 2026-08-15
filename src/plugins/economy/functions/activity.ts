import type { GuildMember, Message } from "discord.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import {
  EconomyError,
  applyMultiplier,
  ensureGuildCurrencies,
  getPrimaryCurrencyKey,
  grantStartingBalance,
  isGuildPaused,
  mutateMoney,
} from "./money.js";
import { assertCooldown, getActiveRewardBoostBps, getCooldown, setCooldown } from "./inventory.js";
import { memberRewardBonusBps, calendarDay } from "./rewards.js";
import { bumpProgress } from "./quests.js";

function accountAgeDays(createdAt: Date): number {
  return (Date.now() - createdAt.getTime()) / 86_400_000;
}

function memberAgeDays(joinedAt: Date | null): number {
  if (!joinedAt) return 0;
  return (Date.now() - joinedAt.getTime()) / 86_400_000;
}

function readMintedToday(guildId: string, userId: string, day: string): number {
  const row = getCooldown(guildId, userId, `activity_minted:${day}`);
  if (!row?.metaJson) return 0;
  try {
    return (JSON.parse(row.metaJson) as { minted?: number }).minted ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Attempt to grant a message activity reward. Returns null when silently skipped
 * (cooldown, filters, caps).
 */
export function tryGrantMessageReward(
  member: GuildMember,
  message: Message,
  config: EconomyConfig,
): { amount: number; currencyKey: string } | null {
  if (!config.modules.activity_rewards) return null;
  if (!message.guild || message.author.bot) return null;
  if (isGuildPaused(message.guild.id, config)) return null;

  const content = message.content?.trim() ?? "";
  if (content.length < config.activity.message_min_length) return null;

  const channelId = message.channelId;
  if (config.activity.denied_channel_ids.includes(channelId)) return null;
  if (
    config.activity.allowed_channel_ids.length > 0 &&
    !config.activity.allowed_channel_ids.includes(channelId)
  ) {
    return null;
  }
  if (config.activity.denied_role_ids.some((id) => member.roles.cache.has(id))) return null;

  if (accountAgeDays(message.author.createdAt) < config.activity.min_account_age_days) return null;
  if (memberAgeDays(member.joinedAt) < config.activity.min_member_age_days) return null;

  const guildId = message.guild.id;
  const userId = member.id;

  try {
    assertCooldown(guildId, userId, "activity_message");
  } catch (err) {
    if (err instanceof EconomyError && err.code === "limit") return null;
    throw err;
  }

  ensureGuildCurrencies(guildId, config);
  grantStartingBalance(guildId, userId, config);
  const currencyKey = getPrimaryCurrencyKey(guildId, config);

  let amount = config.activity.message_amount;
  if (amount <= 0) return null;

  const day = calendarDay(config.rewards.timezone || "UTC");
  if (config.activity.daily_mint_cap > 0) {
    const mintedToday = readMintedToday(guildId, userId, day);
    if (mintedToday >= config.activity.daily_mint_cap) return null;
    amount = Math.min(amount, config.activity.daily_mint_cap - mintedToday);
    if (amount <= 0) return null;
  }

  const bonusBps = memberRewardBonusBps(member, config) + getActiveRewardBoostBps(guildId, userId);
  amount = applyMultiplier(amount, bonusBps);
  if (amount <= 0) return null;

  mutateMoney(
    {
      guildId,
      userId,
      currencyKey,
      deltaPocket: amount,
      reason: "activity_message",
      meta: { channelId, bonusBps },
    },
    { config },
  );

  setCooldown(
    guildId,
    userId,
    "activity_message",
    new Date(Date.now() + config.activity.message_cooldown_seconds * 1000),
  );

  if (config.activity.daily_mint_cap > 0) {
    const prev = readMintedToday(guildId, userId, day);
    setCooldown(guildId, userId, `activity_minted:${day}`, new Date(Date.now() + 86_400_000), {
      minted: prev + amount,
    });
  }

  try {
    bumpProgress(guildId, userId, "message", 1, config);
  } catch {
    /* non-fatal */
  }

  return { amount, currencyKey };
}
