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
import { getSortedInventory } from "../plugins/planes/functions/inventory.js";
import type { CardType } from "../plugins/planes/functions/catalog.js";

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
  /** Opt-in: show the plane/airline trading card collection section. Off by default. */
  showTradingCards: boolean;
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
    showTradingCards: profile.showTradingCards,
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

export type PublicProfileCard = {
  key: string;
  name: string;
  cardType: CardType;
  rarity: string;
  /** Manufacturer for planes, extra info for airlines. */
  subtitle: string;
  /** File name in assets/planes/ — fetch the art from GET /bridge/plane-cards/image/:imageKey. */
  imageKey: string;
  quantity: number;
  firstObtainedAt: string;
  stats: Record<string, number>;
};

export type PublicProfileCards = {
  totalUnique: number;
  totalCards: number;
  cards: PublicProfileCard[];
};

function cardStats(plane: {
  cardType: string;
  speed: number;
  agility: number;
  passengerCount: number;
  reputation: number;
  fleetSize: number;
  destinations: number;
  safety: number;
}): Record<string, number> {
  if (plane.cardType === "airline") {
    return { reputation: plane.reputation, fleetSize: plane.fleetSize, destinations: plane.destinations, safety: plane.safety };
  }
  return { speed: plane.speed, agility: plane.agility, passengerCount: plane.passengerCount, safety: plane.safety };
}

/** A user's plane/airline trading card collection, rarest-first, for the profile page. */
export async function buildPublicProfileCards(userId: string): Promise<PublicProfileCards> {
  const owned = getSortedInventory(userId);
  const cards: PublicProfileCard[] = owned.map(({ plane, quantity, firstObtainedAt }) => ({
    key: plane.key,
    name: plane.name,
    cardType: plane.cardType as CardType,
    rarity: plane.rarity,
    subtitle: plane.subtitle,
    imageKey: plane.imageKey,
    quantity,
    firstObtainedAt: firstObtainedAt.toISOString(),
    stats: cardStats(plane),
  }));
  return {
    totalUnique: cards.length,
    totalCards: cards.reduce((sum, c) => sum + c.quantity, 0),
    cards,
  };
}

/** Combined shape, for consumers that want everything in one response (the public JSON API). */
export type PublicUserProfile = PublicProfileIdentity & {
  stats: { totalMessages: number; globalRank: number | null };
  lastActiveAt: string | null;
  daily: Array<{ date: string; messages: number }>;
  activeHoursUtc: number[];
  guilds: UserGuildSummary[];
  cards: PublicProfileCards;
};

export async function buildPublicUserProfile(
  client: Client,
  userId: string,
): Promise<PublicUserProfile | null> {
  const identity = await buildPublicProfileIdentity(client, userId);
  if (!identity) return null;

  const [stats, daily, activeHoursUtc, guilds, cards] = await Promise.all([
    buildPublicProfileStats(userId),
    buildPublicProfileActivity(userId),
    buildPublicProfileHours(userId),
    buildPublicProfileServers(client, userId),
    buildPublicProfileCards(userId),
  ]);

  return {
    ...identity,
    stats: { totalMessages: stats.totalMessages, globalRank: stats.globalRank },
    lastActiveAt: stats.lastActiveAt,
    daily,
    activeHoursUtc,
    guilds,
    cards,
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
