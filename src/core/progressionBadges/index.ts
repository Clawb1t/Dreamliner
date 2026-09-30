import type { Client } from "discord.js";
import { findBadgeImage, getBadgeImageByKey, readBadgeImage } from "./assets.js";
import { getMetric, MANUAL_METRIC_ID, METRICS } from "./metrics.js";
import {
  countGrantsByBadge,
  getTierImage,
  listGrantsForUsers,
  listStoredBadges,
  type BadgeGrant,
  type StoredBadge,
  type StoredTier,
} from "./store.js";

/**
 * Progression badges: small icons next to a user's name on the /rank card, the public profile and
 * the site's leaderboards (the big profile badges in bridge/userBadges.ts are a separate system).
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
  /** When it was earned or assigned, when known (ISO). */
  since: string | null;
  /** Image key for GET /bridge/progression-badges/image/:key. */
  imageKey: string;
  /** Changes whenever the art changes. */
  imageVersion: string;
};

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

/** Every user's progression badges, in display order. A badge or stat that fails to resolve is
 *  skipped rather than failing the whole card or leaderboard. */
export async function getProgressionBadgesForUsers(client: Client, userIds: string[]): Promise<Map<string, ProgressionBadge[]>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const result = new Map<string, ProgressionBadge[]>();
  if (unique.length === 0) return result;
  const push = (userId: string, badge: ProgressionBadge) => {
    const list = result.get(userId) ?? [];
    list.push(badge);
    result.set(userId, list);
  };

  const [stored, grants] = await Promise.all([
    listStoredBadges().catch(() => [] as StoredBadge[]),
    listGrantsForUsers(unique).catch(() => new Map<string, Map<string, BadgeGrant>>()),
  ]);
  const active = stored.filter((badge) => badge.enabled && badge.tiers.length > 0);
  const metricIds = [...new Set(active.map((badge) => badge.metric).filter((id) => id !== MANUAL_METRIC_ID))];
  const [builtInEarned, metricValues] = await Promise.all([
    Promise.all(BUILT_IN_BADGES.map((badge) => badge.resolve(client, unique).catch(() => new Map<string, string>()))),
    Promise.all(
      metricIds.map((id) => getMetric(id)?.values(client, unique).catch(() => new Map<string, number>()) ?? new Map()),
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
      });
    }
  });

  for (const badge of active) {
    const values = valuesByMetric.get(badge.metric);
    for (const userId of unique) {
      const grant = grants.get(userId)?.get(badge.key);
      const value = values?.get(userId) ?? 0;
      const tierNumber = shownTier(badge, value, grant);
      if (tierNumber === 0) continue;
      const tier = badge.tiers[tierNumber - 1]!;
      const earnedTier = badge.metric === MANUAL_METRIC_ID ? 0 : tiersReached(badge.tiers, value);
      push(userId, {
        id: badge.key,
        name: badge.name,
        description: badge.description,
        tier: badge.tiers.length > 1 ? tierNumber : null,
        tierName: tierLabel(badge.metric, tier),
        since: grant && earnedTier < tierNumber ? grant.grantedAt.toISOString() : null,
        imageKey: `t/${tier.id}`,
        imageVersion: tier.imageVersion,
      });
    }
  }
  return result;
}

export async function getProgressionBadges(client: Client, userId: string): Promise<ProgressionBadge[]> {
  return (await getProgressionBadgesForUsers(client, [userId])).get(userId) ?? [];
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

// --- Superuser dashboard ---------------------------------------------------------------------

export type AdminBadgeTier = {
  id: number | null;
  position: number;
  threshold: number;
  name: string;
  label: string | null;
  imageKey: string | null;
  imageVersion: string | null;
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

export type AdminMetric = { id: string; label: string; unit: string; description: string };

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
        holders: reached ? reached[index]! - (reached[index + 1] ?? 0) : null,
      })),
      assigned: grantCounts.get(badge.key) ?? 0,
    });
  }

  return {
    badges,
    metrics: METRICS.map(({ id, label, unit, description }) => ({ id, label, unit, description })),
  };
}

export type AdminUserBadges = {
  /** What the user shows right now (earned and assigned). */
  shown: ProgressionBadge[];
  /** Hand assignments. */
  assigned: Array<{ badgeKey: string; tier: number | null; grantedAt: string }>;
};

export async function getAdminUserBadges(client: Client, userId: string): Promise<AdminUserBadges> {
  const [shown, grants] = await Promise.all([getProgressionBadges(client, userId), listGrantsForUsers([userId])]);
  return {
    shown,
    assigned: [...(grants.get(userId)?.values() ?? [])].map((grant) => ({
      badgeKey: grant.badgeKey,
      tier: grant.tier,
      grantedAt: grant.grantedAt.toISOString(),
    })),
  };
}
