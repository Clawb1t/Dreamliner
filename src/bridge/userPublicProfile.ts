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

/**
 * The public profile is split into independently-fetchable pieces (identity,
 * stats, activity, hours, servers) instead of one combined builder, so the
 * website can render the page shell the instant identity resolves and stream
 * each card in separately as its own — slower — piece finishes, rather than
 * blocking the whole page on the slowest query. None of this is cached
 * (unlike the rest of the bridge's public data): a profile should always
 * reflect the current state the moment it's opened.
 */

export type PublicProfileIdentity = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  bannerUrl: string | null;
  accentColor: string | null;
  bio: string | null;
  profileVisible: boolean;
  badges: UserBadge[];
};

/** Fast: one forced Discord user fetch (needed for banner) + one DB row + one badge join. */
export async function buildPublicProfileIdentity(
  client: Client,
  userId: string,
): Promise<PublicProfileIdentity | null> {
  let discordUser;
  try {
    discordUser = await client.users.fetch(userId, { force: true });
  } catch {
    discordUser = null;
  }
  if (!discordUser) return null;

  const [profile, badges] = await Promise.all([
    getUserProfile(userId),
    listDisplayedUserBadges(userId),
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
  };
}

export type PublicProfileStats = {
  totalMessages: number;
  globalRank: number | null;
  /** ISO timestamp of the user's most recent tracked message, for "last seen". */
  lastActiveAt: string | null;
};

export async function buildPublicProfileStats(userId: string): Promise<PublicProfileStats> {
  const stats = await getGlobalMessageStats(userId);
  return {
    totalMessages: stats.totalMessages,
    globalRank: stats.globalRank,
    lastActiveAt: stats.lastActiveAt ? stats.lastActiveAt.toISOString() : null,
  };
}

export async function buildPublicProfileActivity(
  userId: string,
): Promise<Array<{ date: string; messages: number }>> {
  return getUserDailyActivity(userId, ACTIVITY_DAYS);
}

export async function buildPublicProfileHours(userId: string): Promise<number[]> {
  return getUserHourlyActivity(userId);
}

export async function buildPublicProfileServers(
  client: Client,
  userId: string,
): Promise<UserGuildSummary[]> {
  return listUserGuildSummaries(client, userId);
}

/** Combined shape, for consumers that want everything in one response (the public JSON API). */
export type PublicUserProfile = PublicProfileIdentity & {
  stats: { totalMessages: number; globalRank: number | null };
  lastActiveAt: string | null;
  daily: Array<{ date: string; messages: number }>;
  activeHoursUtc: number[];
  guilds: UserGuildSummary[];
};

export async function buildPublicUserProfile(
  client: Client,
  userId: string,
): Promise<PublicUserProfile | null> {
  const identity = await buildPublicProfileIdentity(client, userId);
  if (!identity) return null;

  const [stats, daily, activeHoursUtc, guilds] = await Promise.all([
    buildPublicProfileStats(userId),
    buildPublicProfileActivity(userId),
    buildPublicProfileHours(userId),
    buildPublicProfileServers(client, userId),
  ]);

  return {
    ...identity,
    stats: { totalMessages: stats.totalMessages, globalRank: stats.globalRank },
    lastActiveAt: stats.lastActiveAt,
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
