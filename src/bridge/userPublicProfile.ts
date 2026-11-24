import type { Client, User } from "discord.js";
import { invalidateCached } from "./responseCache.js";
import { getUserProfile } from "./userProfiles.js";
import { canViewCrossServerData, getGhostState, type CrossServerAccess } from "../core/privacy/ghostMode.js";
import { dailyActivityFor, dailyVoiceFor, firstSeenFor, globalEconomyFor, globalStatsFor, hourlyActivityFor } from "../core/privacy/crossServer.js";
import { filterBadgesForAccess, isGhostActive } from "../core/privacy/policy.js";
import { listDisplayedUserBadges, type UserBadge } from "./userBadges.js";
import { getProgressionBadges, type ProgressionBadge } from "../core/progressionBadges/index.js";
import { listUserGuildSummaries, type UserGuildSummary } from "./userActivity.js";
import { RARITIES, type Rarity } from "../plugins/economy/hangar/constants.js";
import { getShowcase, listUserCopies } from "../plugins/economy/hangar/copies.js";
import { pilotRankView } from "../plugins/economy/hangar/score.js";
import { setsProgress } from "../plugins/economy/hangar/service.js";
import { getUserState } from "../plugins/economy/hangar/state.js";
import { copyViews, viewContext, type HangarCopyView } from "../plugins/economy/hangar/view.js";
import type { CardType } from "../plugins/economy/functions/catalog.js";
import { getEquippedStyle } from "../core/cosmetics/equip.js";
import type { CosmeticStyle } from "../core/cosmetics/types.js";

/** Days of daily activity on the profile (its range picker offers 7, 30 and 90). */
const ACTIVITY_DAYS = 90;

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
  /** Store cosmetics the user has equipped, resolved (an empty object when none). */
  cosmetics: CosmeticStyle;
  /** What this viewer may see of their activity across servers (core/privacy): "hidden" while
   *  Ghost Mode is on, "snapshot" (00:00 UTC numbers) for everyone else, "live" for themselves and
   *  the people they allow. */
  crossServerAccess: CrossServerAccess;
  /** Only on the owner's own view: their Ghost Mode state (until null = until turned off). */
  ghostMode: { on: boolean; until: string | null } | null;
  /** Their own equipped Discord avatar decoration (animated APNG via passthrough), null when they
   *  have none or turned it off (showAvatarDecoration). */
  avatarDecorationUrl: string | null;
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
const fullyFetchedAt = new Map<string, { at: number; bannerUrl: string | null }>();
const FULL_FETCH_TTL_MS = 30 * 60_000;
const FULL_FETCH_MAX_ENTRIES = 5000;

/**
 * The banner is remembered from the forced fetch itself, not read back off the cached user later:
 * user objects that arrive with messages and member updates patch the cached user with
 * `banner: null`, so an active user's cached copy loses its banner within minutes, and the profile
 * fell back to the blurred avatar even though they have one.
 */
function rememberFullFetch(user: User) {
  fullyFetchedAt.delete(user.id);
  fullyFetchedAt.set(user.id, { at: Date.now(), bannerUrl: user.bannerURL({ size: 1024, extension: "png" }) ?? null });
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
  const last = fullyFetchedAt.get(userId);
  if (known && last !== undefined && Date.now() - last.at < FULL_FETCH_TTL_MS) return known;

  const full = client.users.fetch(userId, { force: true }).then(
    (user) => {
      rememberFullFetch(user);
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
  viewerId: string | null = null,
): Promise<PublicProfileIdentity | null> {
  const discordUser = await profileUser(client, userId, () => {
    invalidateCached(`pp-id:${userId}:`);
    invalidateCached(`pp:${userId}:`);
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
  const access = canViewCrossServerData(viewerId, userId);
  const progressionBadges = filterBadgesForAccess(progressionResult.status === "fulfilled" ? progressionResult.value : [], access);
  let ghostMode: PublicProfileIdentity["ghostMode"] = null;
  if (viewerId === userId) {
    const state = getGhostState(userId);
    const on = isGhostActive(state);
    ghostMode = { on, until: on && state.until ? state.until.toISOString() : null };
  }

  return {
    userId,
    username: discordUser.username,
    displayName: discordUser.globalName ?? discordUser.username,
    avatarUrl: discordUser.displayAvatarURL({ size: 256, extension: "png" }),
    bannerUrl: fullyFetchedAt.get(userId)?.bannerUrl ?? discordUser.bannerURL({ size: 1024, extension: "png" }) ?? null,
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
    cosmetics: safeCosmetics(userId),
    crossServerAccess: access,
    ghostMode,
    avatarDecorationUrl: profile.showAvatarDecoration ? avatarDecorationUrl(discordUser.avatarDecorationData?.asset) : null,
  };
}

/** Discord's CDN form for an avatar decoration preset; `passthrough=true` keeps the animation. */
function avatarDecorationUrl(asset: string | null | undefined): string | null {
  if (!asset || !/^[\w-]+$/.test(asset)) return null;
  return `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?size=240&passthrough=true`;
}

function safeCosmetics(userId: string): CosmeticStyle {
  try {
    return getEquippedStyle(userId);
  } catch {
    return {};
  }
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
  /** "hidden": Ghost Mode, every number below is zero/null and the page shows a note instead. */
  access: CrossServerAccess;
  totalMessages: number;
  globalRank: number | null;
  /** Size of the global ranked pool `globalRank` is out of. */
  activeMessagers: number;
  /** How many servers this user has any tracked message activity in. Just a count, never names. */
  serverCount: number;
  /** Most recent tracked message, for "Active now" / "Last seen 5m ago". Null under Ghost Mode
   *  (unless the viewer is the user or on their allow list). */
  lastActiveAt: string | null;
  /** When the numbers were taken (00:00 UTC today), null when live. */
  asOf: string | null;
  /** First UTC day ("YYYY-MM-DD") Dreamliner tracked them anywhere, for "Member since". Null
   *  under Ghost Mode or when never seen. */
  firstSeenAt: string | null;
  /** Their /daily streak (same gate as the rest), null under Ghost Mode. Shown as "Day streak" on
   *  the profile Overview and the /profile card. */
  dailyStreak: number | null;
};

export async function buildPublicProfileStats(userId: string, viewerId: string | null = null): Promise<PublicProfileStats> {
  const view = globalStatsFor(viewerId, userId);
  if (view.access === "hidden") {
    return { access: "hidden", totalMessages: 0, globalRank: null, activeMessagers: 0, serverCount: 0, lastActiveAt: null, asOf: null, firstSeenAt: null, dailyStreak: null };
  }
  return {
    access: view.access,
    totalMessages: view.totalMessages,
    globalRank: view.globalRank,
    activeMessagers: view.activeMessagers,
    serverCount: view.serverCount,
    lastActiveAt: view.lastActiveAt ? view.lastActiveAt.toISOString() : null,
    asOf: view.asOf,
    firstSeenAt: firstSeenFor(viewerId, userId),
    dailyStreak: dailyStreakFor(viewerId, userId),
  };
}

function dailyStreakFor(viewerId: string | null, userId: string): number | null {
  try {
    return globalEconomyFor(viewerId, userId)?.streak ?? null;
  } catch {
    return null;
  }
}

/** Daily totals for the activity graph (messages and voice minutes): others get days up to
 *  yesterday, nothing under Ghost Mode. */
export async function buildPublicProfileActivity(
  userId: string,
  viewerId: string | null = null,
): Promise<Array<{ date: string; messages: number; voiceMinutes: number }>> {
  const messages = dailyActivityFor(viewerId, userId, ACTIVITY_DAYS).daily;
  const voice = new Map(dailyVoiceFor(viewerId, userId, ACTIVITY_DAYS).daily.map((d) => [d.date, d.minutes]));
  return messages.map((d) => ({ ...d, voiceMinutes: voice.get(d.date) ?? 0 }));
}

/** Active hours: 00:00 UTC values for others, empty under Ghost Mode. */
export async function buildPublicProfileHours(userId: string, viewerId: string | null = null): Promise<number[]> {
  return hourlyActivityFor(viewerId, userId).hours;
}

/** "As seen in these servers": the user's own opt-out applies to everyone but themselves, and
 *  Ghost Mode hides it from everyone they haven't allowed. */
export async function buildPublicProfileServers(
  client: Client,
  userId: string,
  viewerId: string | null = null,
): Promise<UserGuildSummary[]> {
  const access = canViewCrossServerData(viewerId, userId);
  if (access === "hidden") return [];
  const profile = await getUserProfile(userId);
  if (profile.hideServersSection && viewerId !== userId) return [];
  return listUserGuildSummaries(client, userId, 12, access);
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
  /** Copies of this card type the user owns. */
  quantity: number;
  /** When they got their earliest copy still held. */
  firstObtainedAt: string;
  stats: Record<string, number>;
  /** Best livery among their copies (standard < gold < prototype). */
  bestLivery: string;
  hasFirstEdition: boolean;
  highestLevel: number;
  /** Rendered face of their best copy: GET /bridge/hangar/render/copy/:id.png */
  renderUrl: string;
  rarityLabel: string;
  /** "#rrggbb" */
  rarityColor: string;
  /** Labels for bestLivery, e.g. "Gold". */
  liveryLabel: string;
};

export type PublicProfileCards = {
  /** False when the user hasn't opted in with showTradingCards: everything else is empty then. */
  visible: boolean;
  totalUnique: number;
  totalCards: number;
  fleetValue: number;
  pilotRank: ReturnType<typeof pilotRankView> | null;
  setsCompleted: number;
  completedSets: { id: number; key: string; name: string }[];
  /** Up to 3 copies the user picked to show off. */
  showcase: HangarCopyView[];
  /** Their highest-scoring single copy. */
  rarest: HangarCopyView | null;
  cards: PublicProfileCard[];
};

/**
 * A user's card collection for the profile page, rarest-first. Enforces the showTradingCards
 * opt-in here on the bot side, so the endpoint never leaks a hidden collection.
 */
export async function buildPublicProfileCards(userId: string, viewerId: string | null = null): Promise<PublicProfileCards> {
  const profile = await getUserProfile(userId);
  const empty: PublicProfileCards = {
    visible: false,
    totalUnique: 0,
    totalCards: 0,
    fleetValue: 0,
    pilotRank: null,
    setsCompleted: 0,
    completedSets: [],
    showcase: [],
    rarest: null,
    cards: [],
  };
  if (!profile.showTradingCards || !profile.profileVisible) return empty;
  // Ghost Mode hides the Hangar collection (Fleet Value and Pilot Rank move with activity) from
  // everyone but the owner and the people they allow.
  if (canViewCrossServerData(viewerId, userId) === "hidden") return empty;

  const ctx = viewContext();
  const copies = listUserCopies(userId);
  const views = copyViews(copies, ctx);
  const byType = new Map<number, HangarCopyView[]>();
  for (const view of views) {
    const list = byType.get(view.card.id) ?? [];
    list.push(view);
    byType.set(view.card.id, list);
  }
  const cards: PublicProfileCard[] = [...byType.values()]
    .map((list) => {
      const best = [...list].sort((a, b) => b.points - a.points || a.serial - b.serial)[0]!;
      const card = best.card;
      return {
        key: card.key,
        name: card.name,
        cardType: card.cardType as CardType,
        rarity: card.rarity,
        subtitle: card.subtitle,
        imageKey: card.imageKey,
        quantity: list.length,
        firstObtainedAt: list.map((c) => c.acquiredAt).sort()[0]!,
        stats: card.stats,
        bestLivery: best.livery,
        hasFirstEdition: list.some((c) => c.firstEdition),
        highestLevel: Math.max(...list.map((c) => c.level)),
        renderUrl: best.renderUrl,
        rarityLabel: card.rarityLabel,
        rarityColor: card.rarityColor,
        liveryLabel: best.liveryLabel,
      };
    })
    .sort((a, b) => RARITIES.indexOf(b.rarity as Rarity) - RARITIES.indexOf(a.rarity as Rarity) || a.name.localeCompare(b.name));

  const state = getUserState(userId);
  const fleetValue = state?.fleetValue ?? 0;
  const showcaseIds = getShowcase(userId);
  const showcase = showcaseIds.map((id) => views.find((v) => v.id === id)).filter((v): v is HangarCopyView => Boolean(v));
  const rarest = state?.rarestCopyId ? (views.find((v) => v.id === state.rarestCopyId) ?? null) : null;
  const completed = setsProgress(userId).filter((s) => s.completed);
  return {
    visible: true,
    totalUnique: cards.length,
    totalCards: views.length,
    fleetValue,
    pilotRank: views.length ? pilotRankView(fleetValue) : null,
    setsCompleted: completed.length,
    completedSets: completed.map((s) => ({ id: s.id, key: s.key, name: s.name })),
    showcase,
    rarest,
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

  // The public JSON API: always the anonymous view.
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
    // The public JSON API keeps its original 30-day, messages-only shape.
    daily: daily.slice(-30).map(({ date, messages }) => ({ date, messages })),
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
