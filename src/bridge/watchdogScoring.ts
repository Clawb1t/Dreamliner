import { and, eq, gte, inArray } from "drizzle-orm";
import type { Client, Guild, GuildMember } from "discord.js";
import { getDb } from "../db/client.js";
import { automodHits, guildUserTrail, modCases, userMessageCounts } from "../db/schema.js";
import { matchWordPack } from "../plugins/automod/functions/detectors/wordMatch.js";
import { PROFANITY_WORDS } from "../plugins/automod/functions/packs/profanity.js";
import { SLUR_WORDS } from "../plugins/automod/functions/packs/slurs.js";
import { getGuildContentRetentionDays } from "../core/contentRetention.js";
import { configManager } from "../config/manager.js";
import { getPluginSettings } from "../core/permissionRoles.js";
import { zWatchdogConfig, type UtilityConfig, type WatchdogConfig } from "../config/schemas/utility.js";

/**
 * Watchdog: a per-guild risk-scoring view over members, built from signals
 * already sitting in the database (mod history, message trail, content
 * flags) plus live Discord account/member metadata. This is a transparent,
 * weighted heuristic engine, not a trained ML model: every point a user
 * accrues is attached to a human-readable reason (see `WatchdogReason`), and
 * nothing here takes action; it only scores and explains.
 *
 * Deliberately stateless: recomputed fresh on every request from
 * `guild.members.cache` + a handful of batched (not per-member) queries, so
 * it never goes stale and needs no migration/schema of its own.
 *
 * Every point value, tier cutoff, and decay-curve constant lives in a guild's
 * `plugins.utility.config.watchdog` (see `config/schemas/utility.ts`); every
 * `score*` function below takes that resolved config as a trailing parameter
 * with a default equal to the schema's own defaults, so direct unit-test
 * calls that omit it behave exactly as before.
 */

export type WatchdogTier = "low" | "watch" | "elevated" | "critical";

export type WatchdogReason = {
  label: string;
  points: number;
};

export type WatchdogConfidence = {
  /** How many distinct risk categories (identity, history, behavior, standing) contributed at
   * least one nonzero reason. Not the same as the number of reasons, since several reasons can land
   * in the same category. */
  categoryCount: number;
  label: string;
};

export type WatchdogUser = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  score: number;
  tier: WatchdogTier;
  reasons: WatchdogReason[];
  confidence: WatchdogConfidence;
  accountCreatedAt: string;
  joinedAt: string | null;
  strikes: number;
  activeModCases: number;
  totalModCases: number;
  messagesInGuild: number;
  /** True when this user's message-content retention is 0, so content-based signals were skipped for them. */
  contentSkipped: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Schema defaults, used whenever a caller (chiefly the unit tests) doesn't pass a resolved
 * per-guild weights config. Kept in sync with `config/schemas/utility.ts` automatically since
 * it's parsed straight from that schema rather than duplicated here. */
const DEFAULT_WATCHDOG_WEIGHTS: WatchdogConfig = zWatchdogConfig.parse({});

// Scam/phishing phrasing that isn't ordinary profanity: nitro-gifting and
// crypto-airdrop lures are the two most common Discord scam-bot patterns.
const SCAM_KEYWORDS = [
  "free nitro",
  "nitro gift",
  "steam gift",
  "free steam",
  "crypto airdrop",
  "airdrop claim",
  "claim your airdrop",
  "double your crypto",
  "dm me for",
  "check my bio",
  "only fans",
  "onlyfans",
  "cashapp",
  "cash app flip",
];

/**
 * The four broad groups a signal belongs to, for the convergence bonus (item 1) and the
 * confidence indicator (item 4): a score built from several independent kinds of evidence is
 * more trustworthy than the same score from one noisy signal repeated. Exported as a plain
 * constant so tests can assert against it directly.
 */
export const WATCHDOG_SIGNAL_CATEGORIES = {
  accountAge: "identity",
  joinGap: "identity",
  avatar: "identity",
  username: "identity",
  roles: "identity",
  strikes: "history",
  modCases: "history",
  openIncident: "history",
  joinBurst: "behavior",
  duplicateContent: "behavior",
  scamKeywords: "behavior",
  profanityKeywords: "behavior",
  globalStanding: "standing",
} as const;

export type WatchdogSignalKey = keyof typeof WATCHDOG_SIGNAL_CATEGORIES;
export type WatchdogSignalCategory = (typeof WATCHDOG_SIGNAL_CATEGORIES)[WatchdogSignalKey];

export function tierFor(
  score: number,
  tiers: WatchdogConfig["tiers"] = DEFAULT_WATCHDOG_WEIGHTS.tiers,
): WatchdogTier {
  if (score >= tiers.critical) return "critical";
  if (score >= tiers.elevated) return "elevated";
  if (score >= tiers.watch) return "watch";
  return "low";
}

function ageInDays(msSince: number): number {
  return msSince / DAY_MS;
}

/**
 * Linear taper from full weight to a floor percentage between two age thresholds. Linear (rather
 * than an exponential half-life) is deliberately simple: a guild admin retuning
 * `full_weight_days`/`floor_days`/`floor_percent` can reason about the curve directly ("half way
 * between these two days is about half the drop"), and the shape difference doesn't matter much
 * for a heuristic score that's already coarse-grained.
 */
export function decayWeight(ageDays: number, fullWeightDays: number, floorDays: number, floorPercent: number): number {
  const floor = Math.max(0, Math.min(100, floorPercent)) / 100;
  if (ageDays <= fullWeightDays) return 1;
  if (floorDays <= fullWeightDays || ageDays >= floorDays) return floor;
  const t = (ageDays - fullWeightDays) / (floorDays - fullWeightDays);
  return 1 - t * (1 - floor);
}

/** Account-age signal: newer accounts are riskier, decaying to 0 by ~180 days old. */
export function scoreAccountAge(
  createdAt: number,
  now: number,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  const days = ageInDays(now - createdAt);
  if (days < 1) return { label: "Account created within the last 24 hours", points: weights.weights.account_age_new };
  if (days < 7) return { label: "Account is less than a week old", points: weights.weights.account_age_week };
  if (days < 30) return { label: "Account is less than a month old", points: weights.weights.account_age_month };
  if (days < 180) return { label: "Account is less than 6 months old", points: weights.weights.account_age_6_months };
  return null;
}

/** Classic raid/bot pattern: the account was created right before it joined this server. */
export function scoreJoinGap(
  createdAt: number,
  joinedAt: number | null,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  if (joinedAt == null) return null;
  const gapMs = joinedAt - createdAt;
  if (gapMs < 0) return null;
  if (gapMs < 60 * 60 * 1000) {
    return { label: "Joined this server within an hour of account creation", points: weights.weights.join_gap_hour };
  }
  if (gapMs < DAY_MS) {
    return { label: "Joined this server within a day of account creation", points: weights.weights.join_gap_day };
  }
  return null;
}

function scoreAvatar(member: GuildMember, weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS): WatchdogReason | null {
  return member.user.avatar === null
    ? { label: "Using the default Discord avatar", points: weights.weights.default_avatar }
    : null;
}

// Bulk-generated accounts commonly get handles like "user8271" or
// "xj4k2p9931", a short run of letters followed by a long run of digits,
// or a name with no vowels at all. Deliberately conservative to avoid
// flagging normal handles like "player1" or "cool_guy22".
const SUSPICIOUS_USERNAME_RE = /^[a-z]{1,6}\d{4,}$/i;
const NO_VOWEL_RE = /^[^aeiou\s]{6,}$/i;

export function scoreUsername(
  username: string,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  if (SUSPICIOUS_USERNAME_RE.test(username) || NO_VOWEL_RE.test(username)) {
    return { label: "Username matches a bulk-generated handle pattern", points: weights.weights.suspicious_username };
  }
  return null;
}

function scoreRoles(member: GuildMember, weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS): WatchdogReason | null {
  return member.roles.cache.size <= 1
    ? { label: "Has no roles beyond the default @everyone", points: weights.weights.no_extra_roles }
    : null;
}

/**
 * Automod-hit signal (fixed from a dead `modStrikes` read that nothing ever wrote to, per the
 * Part 2 plan). Reads real `automodHits` rows within their 30-day retention window and tapers
 * each hit's weight by age (`decay.automod_hit_*`) before capping the total.
 */
export function scoreStrikes(
  hits: Array<{ createdAt: Date | number }>,
  now: number = Date.now(),
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  if (hits.length === 0) return null;
  const { decay, weights: w } = weights;
  let raw = 0;
  for (const hit of hits) {
    const createdMs = hit.createdAt instanceof Date ? hit.createdAt.getTime() : hit.createdAt;
    const ageDays = ageInDays(now - createdMs);
    const decayFactor = decayWeight(
      ageDays,
      decay.automod_hit_full_weight_days,
      decay.automod_hit_floor_days,
      decay.automod_hit_floor_percent,
    );
    raw += w.automod_hit_per_hit * decayFactor;
  }
  const points = Math.min(w.automod_hit_cap, Math.round(raw));
  if (points <= 0) return null;
  const count = hits.length;
  return { label: `${count} automod hit${count === 1 ? "" : "s"} in the last 30 days`, points };
}

/**
 * Moderation-case signal. Takes raw case rows (rather than pre-aggregated active/total counts)
 * so each case's age can taper its weight (`decay.mod_case_*`) before the total is capped:
 * a case from years ago still counts, just for much less than a recent one.
 */
export function scoreModCases(
  cases: Array<{ active: boolean; createdAt: Date | number }>,
  now: number = Date.now(),
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  if (cases.length === 0) return null;
  const { decay, weights: w } = weights;
  let raw = 0;
  let activeCount = 0;
  for (const c of cases) {
    if (c.active) activeCount += 1;
    const createdMs = c.createdAt instanceof Date ? c.createdAt.getTime() : c.createdAt;
    const ageDays = ageInDays(now - createdMs);
    const decayFactor = decayWeight(
      ageDays,
      decay.mod_case_full_weight_days,
      decay.mod_case_floor_days,
      decay.mod_case_floor_percent,
    );
    raw += (c.active ? w.mod_case_active : w.mod_case_past) * decayFactor;
  }
  const points = Math.min(w.mod_case_cap, Math.round(raw));
  if (points <= 0) return null;
  const total = cases.length;
  return {
    label:
      activeCount > 0
        ? `${activeCount} active moderation case${activeCount === 1 ? "" : "s"} (${total} total)`
        : `${total} past moderation case${total === 1 ? "" : "s"}`,
    points,
  };
}

/** Many messages in the first few minutes after joining, a spam/raid-bot posting pattern. */
export function scoreJoinBurst(
  joinedAt: number | null,
  trail: Array<{ startedAt: Date; messageCount: number }>,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  if (joinedAt == null || trail.length === 0) return null;
  const windowEnd = joinedAt + 5 * 60 * 1000;
  const burst = trail
    .filter((row) => row.startedAt.getTime() <= windowEnd)
    .reduce((sum, row) => sum + row.messageCount, 0);
  if (burst >= 15) {
    return { label: "Sent 15+ messages within 5 minutes of joining", points: weights.weights.join_burst_heavy };
  }
  if (burst >= 6) {
    return { label: "Sent 6+ messages within 5 minutes of joining", points: weights.weights.join_burst_moderate };
  }
  return null;
}

/** Self-bot / advertising pattern: the same text posted across multiple channels. */
export function scoreDuplicateContent(
  trail: Array<{ channelId: string; snippet: string }>,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  const byText = new Map<string, Set<string>>();
  for (const row of trail) {
    const text = row.snippet.trim().toLowerCase();
    if (text.length < 8) continue;
    const channels = byText.get(text) ?? new Set<string>();
    channels.add(row.channelId);
    byText.set(text, channels);
  }
  let maxChannels = 0;
  for (const channels of byText.values()) maxChannels = Math.max(maxChannels, channels.size);
  if (maxChannels >= 3) {
    return { label: "Posted identical content across 3+ channels", points: weights.weights.duplicate_content_heavy };
  }
  if (maxChannels >= 2) {
    return {
      label: "Posted identical content across multiple channels",
      points: weights.weights.duplicate_content_moderate,
    };
  }
  return null;
}

export function scoreKeywordHits(
  trail: Array<{ snippet: string }>,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): { scam: WatchdogReason | null; profanity: WatchdogReason | null } {
  const text = trail.map((row) => row.snippet).join(" \n ");
  if (!text.trim()) return { scam: null, profanity: null };

  const scamHits = matchWordPack(text, SCAM_KEYWORDS);
  const scam =
    scamHits.length > 0
      ? {
          label: `Recent messages contain scam-style phrasing ("${scamHits[0]}")`,
          points: weights.weights.scam_keyword_hit,
        }
      : null;

  const profanityHits = matchWordPack(text, [...PROFANITY_WORDS, ...SLUR_WORDS]);
  const profanity =
    profanityHits.length >= 3
      ? { label: "Repeated profanity/slurs in recent messages", points: weights.weights.profanity_repeated }
      : profanityHits.length > 0
        ? { label: "Profanity in recent messages", points: weights.weights.profanity_single }
        : null;

  return { scam, profanity };
}

export function scoreGlobalStanding(
  createdAt: number,
  now: number,
  globalCount: number,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  const days = ageInDays(now - createdAt);
  if (days < 14 && globalCount <= 2) {
    return { label: "Almost no message history anywhere on the platform", points: weights.weights.low_global_standing };
  }
  return null;
}

/** Cross-reference against Incident Response (item 3): a flat bonus while this user has a still-open
 * incident in this guild, regardless of what triggered it. */
export function scoreOpenIncident(
  hasOpenIncident: boolean,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  if (!hasOpenIncident) return null;
  return { label: "Currently has an open Incident Response case", points: weights.weights.open_incident };
}

/** The convergence bonus from item 1, factored out as a pure function so it's directly unit
 * testable without constructing a `GuildMember`. `categoryCount` is the number of distinct
 * `WatchdogSignalCategory` values with at least one nonzero reason (see `composeWatchdogUser`). */
export function convergenceBonus(
  categoryCount: number,
  weights: WatchdogConfig = DEFAULT_WATCHDOG_WEIGHTS,
): WatchdogReason | null {
  if (categoryCount < 2) return null;
  const points =
    categoryCount >= 3 ? weights.weights.convergence_3_plus_categories : weights.weights.convergence_2_categories;
  return { label: "Multiple independent risk categories align", points };
}

function confidenceLabel(categoryCount: number): string {
  if (categoryCount >= 3) return "3+ independent signal categories";
  if (categoryCount === 2) return "2 signal categories";
  if (categoryCount === 1) return "1 signal category";
  return "No signal categories";
}

async function batchModCases(guildId: string): Promise<Map<string, Array<{ active: boolean; createdAt: Date }>>> {
  const rows = await getDb()
    .select({ userId: modCases.userId, active: modCases.active, createdAt: modCases.createdAt })
    .from(modCases)
    .where(eq(modCases.guildId, guildId))
    .all();
  const map = new Map<string, Array<{ active: boolean; createdAt: Date }>>();
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push({ active: row.active, createdAt: row.createdAt });
    map.set(row.userId, list);
  }
  return map;
}

/** Automod hits within their 30-day retention window, per user. Replaces the old `modStrikes`
 * read (nothing in the codebase ever wrote to that table). */
async function batchAutomodHits(guildId: string): Promise<Map<string, Array<{ createdAt: Date }>>> {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const rows = await getDb()
    .select({ userId: automodHits.userId, createdAt: automodHits.createdAt })
    .from(automodHits)
    .where(and(eq(automodHits.guildId, guildId), gte(automodHits.createdAt, since)))
    .all();
  const map = new Map<string, Array<{ createdAt: Date }>>();
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push({ createdAt: row.createdAt });
    map.set(row.userId, list);
  }
  return map;
}

/** Trail rows from the last 14 days per user, enough for join-burst and duplicate-content checks. */
async function batchUserTrail(
  guildId: string,
): Promise<Map<string, Array<{ channelId: string; startedAt: Date; messageCount: number; snippet: string }>>> {
  const since = new Date(Date.now() - 14 * DAY_MS);
  const rows = await getDb()
    .select()
    .from(guildUserTrail)
    .where(eq(guildUserTrail.guildId, guildId))
    .all();
  const map = new Map<
    string,
    Array<{ channelId: string; startedAt: Date; messageCount: number; snippet: string }>
  >();
  for (const row of rows) {
    if (row.startedAt < since) continue;
    const list = map.get(row.userId) ?? [];
    list.push({
      channelId: row.channelId,
      startedAt: row.startedAt,
      messageCount: row.messageCount,
      snippet: row.snippet,
    });
    map.set(row.userId, list);
  }
  return map;
}

async function batchGlobalMessageCounts(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ userId: userMessageCounts.userId, count: userMessageCounts.count })
    .from(userMessageCounts)
    .where(inArray(userMessageCounts.userId, userIds))
    .all();
  return new Map(rows.map((row) => [row.userId, row.count]));
}

/** Guarded dynamic import, matching the pattern already established by Automod/Incident
 * Response's cross-plugin calls: never breaks if Incident Response is disabled/unavailable. */
async function loadOpenIncidentUserIds(guildId: string): Promise<Set<string>> {
  try {
    const { batchOpenIncidentUserIds } = await import("../plugins/incident_response/functions/store.js");
    return await batchOpenIncidentUserIds(guildId);
  } catch {
    return new Set();
  }
}

async function loadOpenIncidentFlag(guildId: string, userId: string): Promise<boolean> {
  try {
    const { hasOpenIncidentForUser } = await import("../plugins/incident_response/functions/store.js");
    return await hasOpenIncidentForUser(guildId, userId);
  } catch {
    return false;
  }
}

/** 0-1 multiplier: 1 when Passport is unavailable, disabled, or this member hasn't verified. */
async function loadPassportFactor(member: GuildMember): Promise<number> {
  try {
    const { getPassportDeescalationFactor } = await import("../plugins/passport/functions/gate.js");
    return await getPassportDeescalationFactor(member);
  } catch {
    return 1;
  }
}

/** Every member's Passport factor fetched concurrently via `Promise.all`, not a serial
 * await-in-a-loop, so this doesn't become an N+1 across a guild's whole member list. */
async function loadPassportFactors(members: GuildMember[]): Promise<Map<string, number>> {
  const entries = await Promise.all(members.map(async (member) => [member.id, await loadPassportFactor(member)] as const));
  return new Map(entries);
}

async function loadWatchdogWeights(guildId: string): Promise<WatchdogConfig> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  const config = getPluginSettings(guildConfig, "utility") as UtilityConfig;
  return config.watchdog;
}

const MAX_SCORED_MEMBERS = 3000;

type TrailRow = { channelId: string; startedAt: Date; messageCount: number; snippet: string };

/**
 * Shared scoring core: combines one member's signals into a `WatchdogUser`.
 * Used by both `buildWatchdogList` (batched, whole guild, for the dashboard)
 * and `scoreWatchdogMember` (single user, for `/watchdog`) so the two never
 * drift apart: same weights, same reasons, same tiers everywhere.
 */
function composeWatchdogUser(
  member: GuildMember,
  now: number,
  hits: Array<{ createdAt: Date }>,
  cases: Array<{ active: boolean; createdAt: Date }>,
  trail: TrailRow[],
  retentionDays: number,
  globalCount: number,
  hasOpenIncident: boolean,
  passportFactor: number,
  weights: WatchdogConfig,
): WatchdogUser {
  const createdAt = member.user.createdTimestamp;
  const joinedAt = member.joinedTimestamp ?? null;
  const contentSkipped = retentionDays <= 0;

  const tagged: Array<{ key: WatchdogSignalKey; reason: WatchdogReason | null }> = [
    { key: "accountAge", reason: scoreAccountAge(createdAt, now, weights) },
    { key: "joinGap", reason: scoreJoinGap(createdAt, joinedAt, weights) },
    { key: "avatar", reason: scoreAvatar(member, weights) },
    { key: "username", reason: scoreUsername(member.user.username, weights) },
    { key: "roles", reason: scoreRoles(member, weights) },
    { key: "strikes", reason: scoreStrikes(hits, now, weights) },
    { key: "modCases", reason: scoreModCases(cases, now, weights) },
    { key: "openIncident", reason: scoreOpenIncident(hasOpenIncident, weights) },
    { key: "globalStanding", reason: scoreGlobalStanding(createdAt, now, globalCount, weights) },
  ];

  if (!contentSkipped) {
    tagged.push({ key: "joinBurst", reason: scoreJoinBurst(joinedAt, trail, weights) });
    tagged.push({ key: "duplicateContent", reason: scoreDuplicateContent(trail, weights) });
    const { scam, profanity } = scoreKeywordHits(trail, weights);
    tagged.push({ key: "scamKeywords", reason: scam });
    tagged.push({ key: "profanityKeywords", reason: profanity });
  }

  const active = tagged.filter(
    (t): t is { key: WatchdogSignalKey; reason: WatchdogReason } => t.reason !== null,
  );
  const categories = new Set<WatchdogSignalCategory>(active.map((t) => WATCHDOG_SIGNAL_CATEGORIES[t.key]));
  const categoryCount = categories.size;

  const finalReasons: WatchdogReason[] = active.map((t) => t.reason);

  // Convergence bonus (item 1): signals spanning 2+ independent categories are worse news than
  // the same point total piled up from one noisy category, mirroring Incident Response's
  // CORRELATION_BONUS. Added after category counting so the bonus itself never counts as a
  // category of its own.
  const bonus = convergenceBonus(categoryCount, weights);
  if (bonus) finalReasons.push(bonus);

  const rawScore = finalReasons.reduce((sum, r) => sum + r.points, 0);
  const adjustedScore = rawScore * passportFactor;
  const score = Math.max(0, Math.min(100, Math.round(adjustedScore)));

  const messagesInGuild = trail.reduce((sum, row) => sum + row.messageCount, 0);

  return {
    userId: member.id,
    username: member.user.username,
    displayName: member.displayName,
    avatarUrl: member.user.displayAvatarURL({ size: 128 }),
    score,
    tier: tierFor(score, weights.tiers),
    reasons: finalReasons.sort((a, b) => b.points - a.points),
    confidence: { categoryCount, label: confidenceLabel(categoryCount) },
    accountCreatedAt: new Date(createdAt).toISOString(),
    joinedAt: joinedAt != null ? new Date(joinedAt).toISOString() : null,
    strikes: hits.length,
    activeModCases: cases.filter((c) => c.active).length,
    totalModCases: cases.length,
    messagesInGuild,
    contentSkipped,
  };
}

/**
 * Builds the ranked risk list for a guild. Only fetches the full member list
 * when the cache is small (mirrors `buildEntities` in dashboardBridge.ts):
 * on a large guild this relies on whatever's already cached rather than
 * doing a slow full-guild fetch, and the result is capped, so this stays
 * fast regardless of server size.
 */
export async function buildWatchdogList(guild: Guild): Promise<WatchdogUser[]> {
  if (guild.members.cache.size < 100) {
    await guild.members.fetch().catch(() => null);
  }

  const members = [...guild.members.cache.values()].filter((m) => !m.user.bot);
  const userIds = members.map((m) => m.id);

  const [weights, hits, cases, trails, retentionDays, globalCounts, openIncidentUserIds, passportFactors] =
    await Promise.all([
      loadWatchdogWeights(guild.id),
      batchAutomodHits(guild.id),
      batchModCases(guild.id),
      batchUserTrail(guild.id),
      getGuildContentRetentionDays(guild.id),
      batchGlobalMessageCounts(userIds),
      loadOpenIncidentUserIds(guild.id),
      loadPassportFactors(members),
    ]);

  const now = Date.now();

  const scored: WatchdogUser[] = members.map((member) =>
    composeWatchdogUser(
      member,
      now,
      hits.get(member.id) ?? [],
      cases.get(member.id) ?? [],
      trails.get(member.id) ?? [],
      retentionDays,
      globalCounts.get(member.id) ?? 0,
      openIncidentUserIds.has(member.id),
      passportFactors.get(member.id) ?? 1,
      weights,
    ),
  );

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SCORED_MEMBERS);
}

/** Same scoring as `buildWatchdogList`, for exactly one member, used by `/watchdog` in Discord. */
export async function scoreWatchdogMember(member: GuildMember): Promise<WatchdogUser> {
  const guildId = member.guild.id;
  const userId = member.id;
  const since = new Date(Date.now() - 14 * DAY_MS);
  const hitsSince = new Date(Date.now() - 30 * DAY_MS);

  const [weights, hitRows, caseRows, trailRows, retentionDays, globalRow, hasOpenIncident, passportFactor] =
    await Promise.all([
      loadWatchdogWeights(guildId),
      getDb()
        .select({ createdAt: automodHits.createdAt })
        .from(automodHits)
        .where(and(eq(automodHits.guildId, guildId), eq(automodHits.userId, userId), gte(automodHits.createdAt, hitsSince)))
        .all(),
      getDb()
        .select({ active: modCases.active, createdAt: modCases.createdAt })
        .from(modCases)
        .where(and(eq(modCases.guildId, guildId), eq(modCases.userId, userId)))
        .all(),
      getDb()
        .select({
          channelId: guildUserTrail.channelId,
          startedAt: guildUserTrail.startedAt,
          messageCount: guildUserTrail.messageCount,
          snippet: guildUserTrail.snippet,
        })
        .from(guildUserTrail)
        .where(
          and(
            eq(guildUserTrail.guildId, guildId),
            eq(guildUserTrail.userId, userId),
            gte(guildUserTrail.startedAt, since),
          ),
        )
        .all(),
      getGuildContentRetentionDays(guildId),
      getDb()
        .select({ count: userMessageCounts.count })
        .from(userMessageCounts)
        .where(eq(userMessageCounts.userId, userId))
        .get(),
      loadOpenIncidentFlag(guildId, userId),
      loadPassportFactor(member),
    ]);

  return composeWatchdogUser(
    member,
    Date.now(),
    hitRows,
    caseRows,
    trailRows,
    retentionDays,
    globalRow?.count ?? 0,
    hasOpenIncident,
    passportFactor,
    weights,
  );
}

export type GlobalWatchdogScanUser = WatchdogUser & {
  /** Every server this user scored in during the scan (top scorers per server only), highest
   * score first. Not every server they're a member of. */
  guilds: Array<{ id: string; name: string; score: number }>;
};

export type GlobalWatchdogScanResult = {
  users: GlobalWatchdogScanUser[];
  guildsScanned: number;
  scannedAt: string;
};

/** Only each server's own top scorers are folded into the global merge, bounding memory/output
 * size without needing a per-server score cutoff (a server with nobody notable just contributes
 * nothing). */
const GLOBAL_SCAN_PER_GUILD_TOP = 25;
const GLOBAL_SCAN_RESULT_LIMIT = 200;
const GLOBAL_SCAN_CONCURRENCY = 5;

/**
 * A platform-wide version of `buildWatchdogList`: runs the same per-server heuristic scoring
 * across every server the bot is in, then merges by user (keeping their single highest-scoring
 * appearance, plus every server they showed up notably in) so a superuser can spot cross-server
 * bad actors worth adding to the Global Watchdog list. Explicit, on-demand action, not run
 * automatically, since it re-scores every cached member of every guild.
 */
export async function buildGlobalWatchdogScan(client: Client): Promise<GlobalWatchdogScanResult> {
  const guilds = [...client.guilds.cache.values()];
  const merged = new Map<string, GlobalWatchdogScanUser>();

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < guilds.length) {
      const guild = guilds[cursor++]!;
      const scored = await buildWatchdogList(guild).catch(() => []);
      for (const user of scored.slice(0, GLOBAL_SCAN_PER_GUILD_TOP)) {
        const guildEntry = { id: guild.id, name: guild.name, score: user.score };
        const existing = merged.get(user.userId);
        if (!existing) {
          merged.set(user.userId, { ...user, guilds: [guildEntry] });
        } else if (user.score > existing.score) {
          merged.set(user.userId, { ...user, guilds: [...existing.guilds, guildEntry] });
        } else {
          existing.guilds.push(guildEntry);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(GLOBAL_SCAN_CONCURRENCY, guilds.length) }, () => worker()),
  );

  const users = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, GLOBAL_SCAN_RESULT_LIMIT)
    .map((user) => ({ ...user, guilds: user.guilds.sort((a, b) => b.score - a.score) }));

  return { users, guildsScanned: guilds.length, scannedAt: new Date().toISOString() };
}
