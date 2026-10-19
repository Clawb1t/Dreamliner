import type { Client } from "discord.js";
import { invalidateCached } from "./responseCache.js";
import { getGlobalMessageStats } from "./userStats.js";
import { getUserProfile } from "./userProfiles.js";
import { listDisplayedUserBadges, type UserBadge } from "./userBadges.js";
import { getProgressionBadges, type ProgressionBadge } from "../core/progressionBadges/index.js";
import {
  getUserDailyActivity,
  getUserHourlyActivity,
  listUserGuildSummaries,
  type UserGuildSummary,
} from "./userActivity.js";
import { getSortedInventory } from "../plugins/economy/functions/inventory.js";
import type { CardType } from "../plugins/economy/functions/catalog.js";

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
  /** True when this user owns at least one guild with an active Dreamliner One subscription —
   *  powers the small One icon + "subscribed for X" tooltip next to their name on their public
   *  profile (same OneBadge component/tooltip used next to server names). */
  oneOwner: boolean;
  /** ISO timestamp of the earliest-started active subscription among guilds they own, null if
   *  `oneOwner` is false or unknown. */
  oneOwnerSince: string | null;
  /** Automatic progression badges (Dreamliner One included), shown right after the name. */
  progressionBadges: ProgressionBadge[];
};

const TIMED_OUT = Symbol("timed-out");

/** Resolves to TIMED_OUT after `ms` instead of waiting on Discord indefinitely. */
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

/** Discord didn't answer in time for a user the bot has never seen; the caller should retry soon. */
export class ProfileBusyError extends Error {
  constructor() {
    super("Discord is slow to respond right now. Try again in a moment.");
    this.name = "ProfileBusyError";
  }
}

/**
 * When each user was last force-fetched from Discord. Only a forced `users.fetch` returns the real
 * banner: the user objects embedded in messages/members carry `banner: null` even when the user
 * has one (see `ensureBannerLoaded` in webStats.ts), so `user.banner !== undefined` proves nothing.
 */
const fullyFetchedAt = new Map<string, number>();
const FULL_FETCH_TTL_MS = 30 * 60_000;
const FULL_FETCH_MAX_ENTRIES = 5000;

function rememberFullFetch(userId: string) {
  fullyFetchedAt.delete(userId);
  fullyFetchedAt.set(userId, Date.now());
  if (fullyFetchedAt.size > FULL_FETCH_MAX_ENTRIES) {
    const oldest = fullyFetchedAt.keys().next().value;
    if (oldest !== undefined) fullyFetchedAt.delete(oldest);
  }
}

/**
 * The profile's Discord user (banner included), without making the page wait on Discord when it
 * doesn't have to. A user force-fetched in the last 30 min is used from cache. Otherwise a forced
 * fetch runs: a user the bot already knows waits up to 2.5s, then is shown as known while the fetch
 * finishes, and `onLateFull` fires when it does so the caller can rebuild with the banner. A user
 * the bot has never seen waits up to 6s, then ProfileBusyError (never a page left loading until the
 * website gives up).
 */
async function profileUser(client: Client, userId: string, onLateFull: () => void) {
  const known = client.users.cache.get(userId);
  const fetchedAt = fullyFetchedAt.get(userId);
  if (known && fetchedAt !== undefined && Date.now() - fetchedAt < FULL_FETCH_TTL_MS) return known;

  const full = client.users.fetch(userId, { force: true }).then(
    (user) => {
      rememberFullFetch(userId);
      return user;
    },
    () => null,
  );
  if (known) {
    const fetched = await within(full, 2500);
    if (fetched === TIMED_OUT) {
      void full.then((user) => user && onLateFull());
      return known;
    }
    return fetched ?? known;
  }
  const fetched = await within(full, 6000);
  if (fetched === TIMED_OUT) throw new ProfileBusyError();
  return fetched; // null: Discord says there's no such user
}

/** Fast: usually no Discord request at all (see profileUser) + one DB row + one badge join. */
export async function buildPublicProfileIdentity(
  client: Client,
  userId: string,
): Promise<PublicProfileIdentity | null> {
  const discordUser = await profileUser(client, userId, () => {
    invalidateCached(`pp-id:${userId}`);
    invalidateCached(`pp:${userId}`);
  });
  if (!discordUser) return null;

  // Each extra is optional: one failing query must not take the whole profile down.
  const [profileResult, badgesResult, oneOwnerResult, progressionResult] = await Promise.allSettled([
    getUserProfile(userId),
    listDisplayedUserBadges(userId),
    resolveOneOwnerSince(client, userId),
    getProgressionBadges(client, userId),
  ]);
  if (profileResult.status === "rejected") throw profileResult.reason;
  const profile = profileResult.value;
  const badges = badgesResult.status === "fulfilled" ? badgesResult.value : [];
  const oneOwnerSince = oneOwnerResult.status === "fulfilled" ? oneOwnerResult.value : null;
  const progressionBadges = progressionResult.status === "fulfilled" ? progressionResult.value : [];

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
    oneOwner: oneOwnerSince != null,
    oneOwnerSince,
    progressionBadges,
  };
}

/** Earliest `since` among active Dreamliner One subscriptions on guilds this user owns, null if
 *  they own none. `guild.ownerId` is read straight off the cache — no extra fetch needed. */
async function resolveOneOwnerSince(client: Client, userId: string): Promise<string | null> {
  const { listActiveOneGuildsSince } = await import("./dreamlinerOne.js");
  const activeSince = await listActiveOneGuildsSince();
  let earliest: string | null = null;
  for (const [guildId, since] of activeSince) {
    if (client.guilds.cache.get(guildId)?.ownerId !== userId) continue;
    if (earliest == null || since < earliest) earliest = since;
  }
  return earliest;
}

export type PublicProfileStats = {
  totalMessages: number;
  globalRank: number | null;
  /** Size of the global ranked pool `globalRank` is out of (everyone with >= 1 tracked message). */
  activeMessagers: number;
  /** How many servers this user has any tracked message activity in — always shown, independent
   *  of the profile's `hideServersSection` setting, since it's just a count, not identifying. */
  serverCount: number;
  /** ISO timestamp of the user's most recent tracked message, for "last seen". */
  lastActiveAt: string | null;
};

export async function buildPublicProfileStats(userId: string): Promise<PublicProfileStats> {
  const stats = await getGlobalMessageStats(userId);
  return {
    totalMessages: stats.totalMessages,
    globalRank: stats.globalRank,
    activeMessagers: stats.activeMessagers,
    serverCount: stats.serverCount,
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
  const profile = await getUserProfile(userId);
  if (profile.hideServersSection) return [];
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
