import type { Client } from "discord.js";
import { findBadgeImage, getBadgeImageByKey, readBadgeImage } from "./assets.js";
import { cachedMetricValues, countTrackedUsers, getMetric, MANUAL_METRIC_ID, METRICS, type MetricCategory, type SuggestedTier } from "./metrics.js";
import { resolveUnlocks, type HeldTier } from "./unlocks.js";
import { isGeneratedArt } from "./store.js";
import {
  countGrantsByBadge,
  getTierImage,
  listGrantsForUsers,
  listHiddenForUsers,
  listStoredBadges,
  type BadgeGrant,
  type StoredBadge,
  type StoredTier,
} from "./store.js";

/**
 * Progression badges: small icons next to a user's name on the /rank card, the public profile and
 * the site's leaderboards. They're the only badges shown anywhere: the old platform badges in
 * bridge/userBadges.ts are retired (their rows are kept, but nothing displays them).
 *
 * Two sources:
 *   - Built-ins, defined here with art in assets/badges/progression/ (Dreamliner One).
 *   - Badges made on the superuser dashboard (store.ts): a tracked stat (metrics.ts) plus up to
 *     ten tiers, each with its own uploaded art and goal.
 * Any badge can also be assigned by hand at a chosen tier; a user shows the higher of their
 * earned and assigned tier.
 */

/** What the /rank card and the website receive. */
export type ProgressionBadge = {
  /** The badge key (e.g. "dreamliner_one", "messages"). */
  id: string;
  name: string;
  description: string;
  /** 1-based tier for badges with several tiers, null for badges with one look. */
  tier: number | null;
  tierName: string | null;
  /** When the tier they show was unlocked or assigned, when known (ISO). Tiers held before
   *  unlock tracking began (migration 0166) have no date. */
  since: string | null;
  /** Image key for GET /bridge/progression-badges/image/:key. */
  imageKey: string;
  /** Changes whenever the art changes. */
  imageVersion: string;
  /** Only present when asked for hidden badges too: true when the user chose to hide it. */
  hidden?: boolean;
  /** How far along the tracked stat they are, for badges earned from a stat. Null for built-ins
   *  and assigned-only badges. */
  progress: BadgeProgress | null;
};

export type BadgeProgress = {
  /** Their current value of the tracked stat. */
  value: number;
  /** Plural unit, e.g. "messages". */
  unit: string;
  /** Singular unit, e.g. "message". */
  unitOne: string;
  /** Goal of the tier they're on (the start of the progress bar). */
  current: number;
  /** The next tier, or null at the top tier. */
  next: { tier: number; threshold: number; name: string | null } | null;
};

/** Progress from the tier a user shows toward the one after it. */
export function badgeProgress(
  badge: Pick<StoredBadge, "metric" | "tiers">,
  value: number,
  tierNumber: number,
): BadgeProgress | null {
  const metric = getMetric(badge.metric);
  if (!metric || badge.metric === MANUAL_METRIC_ID) return null;
  const nextTier = badge.tiers[tierNumber];
  return {
    value,
    unit: metric.unit,
    unitOne: metric.unitOne,
    current: badge.tiers[tierNumber - 1]?.threshold ?? 0,
    next: nextTier ? { tier: tierNumber + 1, threshold: nextTier.threshold, name: tierLabel(badge.metric, nextTier) } : null,
  };
}

// --- Built-ins -------------------------------------------------------------------------------

type BuiltInBadge = {
  key: string;
  name: string;
  description: string;
  /** Earned users mapped to when they earned it (ISO). */
  resolve(client: Client, userIds: string[]): Promise<Map<string, string>>;
};

const ONE_CACHE_TTL_MS = 60_000;
let oneOwnersCache: { at: number; since: Map<string, string> } | null = null;

/** Earliest active One subscription start per guild owner, from the guilds the bot can see. */
async function oneOwnerSinceByUser(client: Client): Promise<Map<string, string>> {
  if (oneOwnersCache && Date.now() - oneOwnersCache.at < ONE_CACHE_TTL_MS) return oneOwnersCache.since;
  const { listActiveOneGuildsSince } = await import("../../bridge/dreamlinerOne.js");
  const byOwner = new Map<string, string>();
  for (const [guildId, since] of await listActiveOneGuildsSince()) {
    const ownerId = client.guilds.cache.get(guildId)?.ownerId;
    if (!ownerId) continue;
    const current = byOwner.get(ownerId);
    if (current == null || since < current) byOwner.set(ownerId, since);
  }
  oneOwnersCache = { at: Date.now(), since: byOwner };
  return byOwner;
}

export const BUILT_IN_BADGES: BuiltInBadge[] = [
  {
    key: "dreamliner_one",
    name: "Dreamliner One",
    description: "Owns a server subscribed to Dreamliner One",
    async resolve(client, userIds) {
      const byOwner = await oneOwnerSinceByUser(client);
      return new Map(userIds.filter((id) => byOwner.has(id)).map((id) => [id, byOwner.get(id)!]));
    },
  },
];

export const BUILT_IN_KEYS = BUILT_IN_BADGES.map((badge) => badge.key);

// --- Resolution ------------------------------------------------------------------------------

/** "1,000+ messages" when a tier has no name of its own. */
export function tierLabel(metricId: string, tier: Pick<StoredTier, "name" | "threshold">): string | null {
  if (tier.name) return tier.name;
  const metric = getMetric(metricId);
  if (!metric || metricId === MANUAL_METRIC_ID) return null;
  return `${tier.threshold.toLocaleString("en-US")}+ ${metric.unit}`;
}

/** Tiers reached by a value: tiers are in goal order, so this is how many goals are met. */
export function tiersReached(tiers: Array<Pick<StoredTier, "threshold">>, value: number): number {
  let reached = 0;
  for (const tier of tiers) if (value >= tier.threshold) reached++;
  return reached;
}

/** The tier a user shows (1-based, 0 = none): the higher of earned and assigned. */
export function shownTier(badge: Pick<StoredBadge, "metric" | "tiers">, value: number, grant: Pick<BadgeGrant, "tier"> | undefined): number {
  const earned = badge.metric === MANUAL_METRIC_ID ? 0 : tiersReached(badge.tiers, value);
  const assigned = grant ? Math.min(Math.max(grant.tier ?? 1, 1), badge.tiers.length) : 0;
  return Math.max(earned, assigned);
}

/** Every user's progression badges, in display order. Badges a user chose to hide are left out
 *  unless `includeHidden` (their own settings, the superuser view), where they're flagged instead.
 *  A badge or stat that fails to resolve is skipped rather than failing the whole card or leaderboard. */
export async function getProgressionBadgesForUsers(
  client: Client,
  userIds: string[],
  options: { includeHidden?: boolean } = {},
): Promise<Map<string, ProgressionBadge[]>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const result = new Map<string, ProgressionBadge[]>();
  if (unique.length === 0) return result;

  const [stored, grants, hiddenByUser] = await Promise.all([
    listStoredBadges().catch(() => [] as StoredBadge[]),
    listGrantsForUsers(unique).catch(() => new Map<string, Map<string, BadgeGrant>>()),
    listHiddenForUsers(unique).catch(() => new Map<string, Set<string>>()),
  ]);
  const push = (userId: string, badge: ProgressionBadge) => {
    const hidden = hiddenByUser.get(userId)?.has(badge.id) ?? false;
    if (hidden && !options.includeHidden) return;
    const list = result.get(userId) ?? [];
    list.push(options.includeHidden ? { ...badge, hidden } : badge);
    result.set(userId, list);
  };
  const active = stored.filter((badge) => badge.enabled && badge.tiers.length > 0);
  const metricIds = [...new Set(active.map((badge) => badge.metric).filter((id) => id !== MANUAL_METRIC_ID))];
  const [builtInEarned, metricValues] = await Promise.all([
    Promise.all(BUILT_IN_BADGES.map((badge) => badge.resolve(client, unique).catch(() => new Map<string, string>()))),
    Promise.all(
      metricIds.map((id) => {
        const metric = getMetric(id);
        return metric ? cachedMetricValues(metric, client, unique).catch(() => new Map<string, number>()) : new Map<string, number>();
      }),
    ),
  ]);
  const valuesByMetric = new Map(metricIds.map((id, index) => [id, metricValues[index]!]));

  BUILT_IN_BADGES.forEach((badge, index) => {
    const image = findBadgeImage(badge.key, null);
    if (!image) return;
    for (const userId of unique) {
      const grant = grants.get(userId)?.get(badge.key);
      const since = builtInEarned[index]!.get(userId) ?? grant?.grantedAt.toISOString();
      if (since == null) continue;
      push(userId, {
        id: badge.key,
        name: badge.name,
        description: badge.description,
        tier: null,
        tierName: null,
        since,
        imageKey: image.key,
        imageVersion: image.version,
        progress: null,
      });
    }
  });

  // Every stat badge each user holds, worked out first so their unlock dates resolve in one go.
  const held: Array<HeldTier & { badge: StoredBadge; value: number; earnedTier: number; grant: BadgeGrant | undefined }> = [];
  for (const badge of active) {
    const values = valuesByMetric.get(badge.metric);
    for (const userId of unique) {
      const grant = grants.get(userId)?.get(badge.key);
      const value = values?.get(userId) ?? 0;
      const tierNumber = shownTier(badge, value, grant);
      if (tierNumber === 0) continue;
      const earnedTier = badge.metric === MANUAL_METRIC_ID ? 0 : tiersReached(badge.tiers, value);
      held.push({ userId, badgeKey: badge.key, tier: tierNumber, badge, value, earnedTier, grant });
    }
  }
  // Only earned tiers get unlock dates; an assigned tier shows when it was assigned.
  const unlockedAt = resolveUnlocks(held.filter((entry) => entry.earnedTier >= entry.tier));
  for (const { userId, badge, tier: tierNumber, value, earnedTier, grant } of held) {
    const tier = badge.tiers[tierNumber - 1]!;
    push(userId, {
      id: badge.key,
      name: badge.name,
      description: badge.description,
      tier: badge.tiers.length > 1 ? tierNumber : null,
      tierName: tierLabel(badge.metric, tier),
      since:
        grant && earnedTier < tierNumber ? grant.grantedAt.toISOString() : (unlockedAt.get(`${userId}:${badge.key}`) ?? null),
      imageKey: `t/${tier.id}`,
      imageVersion: tier.imageVersion,
      progress: badgeProgress(badge, value, tierNumber),
    });
  }
  return result;
}

export async function getProgressionBadges(
  client: Client,
  userId: string,
  options: { includeHidden?: boolean } = {},
): Promise<ProgressionBadge[]> {
  return (await getProgressionBadgesForUsers(client, [userId], options)).get(userId) ?? [];
}

/** Art for an image key: "t/<tierId>" for dashboard uploads, otherwise a file in the assets
 *  folder. Null when unknown. */
export async function loadBadgeImage(key: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const tierMatch = /^t\/(\d+)$/.exec(key);
  if (tierMatch) return getTierImage(Number(tierMatch[1]));
  const image = getBadgeImageByKey(key);
  if (!image) return null;
  return { buffer: readBadgeImage(image), contentType: image.contentType };
}

// --- Public badge info (the site's badge modal) ----------------------------------------------

export type PublicBadgeTier = {
  position: number;
  threshold: number;
  /** The tier's name, or an automatic one like "1,000+ messages". */
  label: string | null;
  /** What it takes, e.g. "Send 1,000 messages". */
  requirement: string;
  imageKey: string | null;
  imageVersion: string | null;
  /** People on exactly this tier right now, null when it can't be counted. */
  holders: number | null;
  /** Share of tracked users (0-100) who have reached this tier or higher, null when unknown. */
  reachedPct: number | null;
};

export type PublicBadgeMetric = {
  id: string;
  label: string;
  unit: string;
  unitOne: string;
  description: string;
  /** How to move up, e.g. "Send messages in any server with Dreamliner." */
  levelUp: string;
};

export type PublicBadgeInfo = {
  key: string;
  name: string;
  description: string;
  builtIn: boolean;
  /** The tracked stat, null for built-ins and assigned-only badges. */
  metric: PublicBadgeMetric | null;
  assignedOnly: boolean;
  tiers: PublicBadgeTier[];
};

/** Rarity: the share of tracked users who've reached it (one decimal; tiny shares stay above 0). */
export function reachedPercent(reached: number | null | undefined, tracked: number): number | null {
  if (reached == null || tracked <= 0) return null;
  const pct = (Math.min(reached, tracked) / tracked) * 100;
  if (pct > 0 && pct < 0.1) return 0.1;
  return Math.round(pct * 10) / 10;
}

function publicMetric(id: string): PublicBadgeMetric | null {
  const metric = getMetric(id);
  if (!metric || id === MANUAL_METRIC_ID) return null;
  return {
    id: metric.id,
    label: metric.label,
    unit: metric.unit,
    unitOne: metric.unitOne,
    description: metric.description,
    levelUp: metric.levelUp,
  };
}

const INFO_CACHE_TTL_MS = 5 * 60_000;
const infoCache = new Map<string, { at: number; info: PublicBadgeInfo | null }>();

/** Every tier of a badge and what it takes, for anyone viewing it on the site. Hidden (turned
 *  off) badges aren't described. Cached briefly, since holder counts scan the stat tables. */
export async function getPublicBadgeInfo(client: Client, key: string): Promise<PublicBadgeInfo | null> {
  const cached = infoCache.get(key);
  if (cached && Date.now() - cached.at < INFO_CACHE_TTL_MS) return cached.info;

  let info: PublicBadgeInfo | null = null;
  const builtIn = BUILT_IN_BADGES.find((badge) => badge.key === key);
  if (builtIn) {
    const image = findBadgeImage(builtIn.key, null);
    const holders = builtIn.key === "dreamliner_one" ? (await oneOwnerSinceByUser(client).catch(() => null))?.size ?? null : null;
    const tracked = safeTrackedUsers();
    info = {
      key: builtIn.key,
      name: builtIn.name,
      description: builtIn.description,
      builtIn: true,
      metric: null,
      assignedOnly: false,
      tiers: [
        {
          position: 1,
          threshold: 1,
          label: null,
          requirement:
            builtIn.key === "dreamliner_one" ? "Own a server with an active Dreamliner One subscription" : builtIn.description,
          imageKey: image?.key ?? null,
          imageVersion: image?.version ?? null,
          holders,
          reachedPct: reachedPercent(holders, tracked),
        },
      ],
    };
  } else {
    const badge = (await listStoredBadges()).find((entry) => entry.key === key && entry.enabled);
    if (badge && badge.tiers.length > 0) {
      const metric = getMetric(badge.metric);
      const assignedOnly = badge.metric === MANUAL_METRIC_ID;
      let reached: number[] | null = null;
      if (!assignedOnly && metric?.countAtLeast) {
        reached = await metric.countAtLeast(client, badge.tiers.map((tier) => tier.threshold)).catch(() => null);
      }
      const tracked = safeTrackedUsers();
      info = {
        key: badge.key,
        name: badge.name,
        description: badge.description,
        builtIn: false,
        metric: assignedOnly ? null : publicMetric(badge.metric),
        assignedOnly,
        tiers: badge.tiers.map((tier, index) => ({
          position: tier.position,
          threshold: tier.threshold,
          label: tierLabel(badge.metric, tier),
          requirement:
            assignedOnly || !metric
              ? "Assigned by the Dreamliner team"
              : `Reach ${tier.threshold.toLocaleString("en-US")} ${metric.unit}`,
          imageKey: `t/${tier.id}`,
          imageVersion: tier.imageVersion,
          holders: reached ? reached[index]! - (reached[index + 1] ?? 0) : null,
          reachedPct: reachedPercent(reached?.[index], tracked),
        })),
      };
    }
  }
  if (info) {
    for (const [cachedKey, entry] of infoCache) {
      if (Date.now() - entry.at >= INFO_CACHE_TTL_MS) infoCache.delete(cachedKey);
    }
    infoCache.set(key, { at: Date.now(), info });
  }
  return info;
}

function safeTrackedUsers(): number {
  try {
    return countTrackedUsers();
  } catch {
    return 0;
  }
}

/** Every badge anyone can see (built-ins and turned-on dashboard badges), in display order, for
 *  the badge window's "Discover" list and its tier rows. Each entry is cached like
 *  getPublicBadgeInfo. */
export async function listPublicBadgeCatalog(client: Client): Promise<PublicBadgeInfo[]> {
  const stored = await listStoredBadges().catch(() => [] as StoredBadge[]);
  const keys = [...BUILT_IN_KEYS, ...stored.filter((badge) => badge.enabled && badge.tiers.length > 0).map((badge) => badge.key)];
  const infos = await Promise.all(keys.map((key) => getPublicBadgeInfo(client, key).catch(() => null)));
  return infos.filter((info): info is PublicBadgeInfo => info != null);
}

// --- Superuser dashboard ---------------------------------------------------------------------

export type AdminBadgeTier = {
  id: number | null;
  position: number;
  threshold: number;
  name: string;
  label: string | null;
  imageKey: string | null;
  imageVersion: string | null;
  /** True when the art was drawn for it (no image uploaded yet). */
  generatedArt: boolean;
  /** Users whose stat currently puts them on exactly this tier, null when it can't be counted. */
  holders: number | null;
};

export type AdminBadge = {
  id: number | null;
  key: string;
  name: string;
  description: string;
  metric: string;
  enabled: boolean;
  builtIn: boolean;
  tiers: AdminBadgeTier[];
  /** Users with this badge assigned by hand. */
  assigned: number;
};

export type AdminMetric = {
  id: string;
  label: string;
  unit: string;
  unitOne: string;
  description: string;
  levelUp: string;
  category: MetricCategory;
  /** A starting ladder the dashboard can prefill (never saved on its own). */
  suggestedTiers: SuggestedTier[];
};

export async function listAdminBadges(client: Client): Promise<{ badges: AdminBadge[]; metrics: AdminMetric[] }> {
  const [stored, grantCounts] = await Promise.all([listStoredBadges(), Promise.resolve(countGrantsByBadge())]);
  const badges: AdminBadge[] = [];

  for (const badge of BUILT_IN_BADGES) {
    const image = findBadgeImage(badge.key, null);
    const owners = badge.key === "dreamliner_one" ? (await oneOwnerSinceByUser(client).catch(() => new Map())).size : null;
    badges.push({
      id: null,
      key: badge.key,
      name: badge.name,
      description: badge.description,
      metric: "built_in",
      enabled: true,
      builtIn: true,
      tiers: [
        {
          id: null,
          position: 1,
          threshold: 1,
          name: "",
          label: null,
          imageKey: image?.key ?? null,
          imageVersion: image?.version ?? null,
          generatedArt: false,
          holders: owners,
        },
      ],
      assigned: grantCounts.get(badge.key) ?? 0,
    });
  }

  for (const badge of stored) {
    const metric = getMetric(badge.metric);
    let reached: number[] | null = null;
    if (metric?.countAtLeast && badge.metric !== MANUAL_METRIC_ID) {
      reached = await metric.countAtLeast(client, badge.tiers.map((tier) => tier.threshold)).catch(() => null);
    }
    badges.push({
      id: badge.id,
      key: badge.key,
      name: badge.name,
      description: badge.description,
      metric: badge.metric,
      enabled: badge.enabled,
      builtIn: false,
      tiers: badge.tiers.map((tier, index) => ({
        id: tier.id,
        position: tier.position,
        threshold: tier.threshold,
        name: tier.name,
        label: tierLabel(badge.metric, tier),
        imageKey: `t/${tier.id}`,
        imageVersion: tier.imageVersion,
        generatedArt: isGeneratedArt(tier.imageVersion),
        holders: reached ? reached[index]! - (reached[index + 1] ?? 0) : null,
      })),
      assigned: grantCounts.get(badge.key) ?? 0,
    });
  }

  return {
    badges,
    metrics: METRICS.map(({ id, label, unit, unitOne, description, levelUp, category, suggestedTiers }) => ({
      id,
      label,
      unit,
      unitOne,
      description,
      levelUp,
      category,
      suggestedTiers,
    })),
  };
}

export type AdminUserBadges = {
  /** What the user holds right now (earned and assigned); `hidden` marks ones they chose to hide. */
  shown: ProgressionBadge[];
  /** Hand assignments. */
  assigned: Array<{ badgeKey: string; tier: number | null; grantedAt: string }>;
};

export async function getAdminUserBadges(client: Client, userId: string): Promise<AdminUserBadges> {
  const [shown, grants] = await Promise.all([
    getProgressionBadges(client, userId, { includeHidden: true }),
    listGrantsForUsers([userId]),
  ]);
  return {
    shown,
    assigned: [...(grants.get(userId)?.values() ?? [])].map((grant) => ({
      badgeKey: grant.badgeKey,
      tier: grant.tier,
      grantedAt: grant.grantedAt.toISOString(),
    })),
  };
}
