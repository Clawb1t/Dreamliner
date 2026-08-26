import type { Client } from "discord.js";
import { getGlobalMessageStats } from "./userStats.js";
import { getUserProfile } from "./userProfiles.js";
import { listDisplayedUserBadges, type UserBadge } from "./userBadges.js";
import {
  getUserDailyActivity,
  getUserHourlyActivity,
  listUserGuildSummaries,
  type UserGuildSummary,
} from "./userActivity.js";

const ACTIVITY_DAYS = 30;

export type PublicUserProfile = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  bannerUrl: string | null;
  accentColor: string | null;
  bio: string | null;
  profileVisible: boolean;
  badges: UserBadge[];
  stats: {
    totalMessages: number;
    globalRank: number | null;
  };
  /** ISO timestamp of the user's most recent tracked message, for "last seen". */
  lastActiveAt: string | null;
  daily: Array<{ date: string; messages: number }>;
  activeHoursUtc: number[];
  guilds: UserGuildSummary[];
};

export async function buildPublicUserProfile(
  client: Client,
  userId: string,
): Promise<PublicUserProfile | null> {
  let discordUser;
  try {
    discordUser = await client.users.fetch(userId, { force: true });
  } catch {
    discordUser = null;
  }
  if (!discordUser) return null;

  const [profile, badges, stats, daily, activeHoursUtc, guilds] = await Promise.all([
    getUserProfile(userId),
    listDisplayedUserBadges(userId),
    getGlobalMessageStats(userId),
    getUserDailyActivity(userId, ACTIVITY_DAYS),
    getUserHourlyActivity(userId),
    listUserGuildSummaries(client, userId),
  ]);

  return {
    userId,
    username: discordUser.username,
    displayName: discordUser.globalName ?? discordUser.username,
    avatarUrl: discordUser.displayAvatarURL({ size: 256, extension: "png" }),
    bannerUrl: discordUser.bannerURL({ size: 1024, extension: "png" }) ?? null,
    // Falls back to the user's avatar's most pronounced color when they haven't set one
    // themselves (computed website-side, since it needs image decoding this process doesn't do).
    accentColor: profile.accentColor,
    bio: profile.bio,
    profileVisible: profile.profileVisible,
    badges,
    stats: { totalMessages: stats.totalMessages, globalRank: stats.globalRank },
    lastActiveAt: stats.lastActiveAt ? stats.lastActiveAt.toISOString() : null,
    daily,
    activeHoursUtc,
    guilds,
  };
}

export type DiscordUserLookup = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
};

export async function lookupDiscordUser(
  client: Client,
  userId: string,
): Promise<DiscordUserLookup | null> {
  let discordUser;
  try {
    discordUser = await client.users.fetch(userId);
  } catch {
    discordUser = null;
  }
  if (!discordUser) return null;
  return {
    id: discordUser.id,
    username: discordUser.username,
    displayName: discordUser.globalName ?? discordUser.username,
    avatarUrl: discordUser.displayAvatarURL({ size: 128, extension: "png" }),
  };
}
