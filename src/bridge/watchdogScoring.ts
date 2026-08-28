import { and, eq, gte, inArray } from "drizzle-orm";
import type { Guild, GuildMember } from "discord.js";
import { getDb } from "../db/client.js";
import {
  guildUserTrail,
  modCases,
  modStrikes,
  userMessageCounts,
  userProfiles,
} from "../db/schema.js";
import { matchWordPack } from "../plugins/automod/functions/detectors/wordMatch.js";
import { PROFANITY_WORDS } from "../plugins/automod/functions/packs/profanity.js";
import { SLUR_WORDS } from "../plugins/automod/functions/packs/slurs.js";
import { DEFAULT_CONTENT_RETENTION_DAYS } from "../core/contentRetention.js";

/**
 * Watchdog: a per-guild risk-scoring view over members, built from signals
 * already sitting in the database (mod history, message trail, content
 * flags) plus live Discord account/member metadata. This is a transparent,
 * weighted heuristic engine, not a trained ML model — every point a user
 * accrues is attached to a human-readable reason (see `WatchdogReason`), and
 * nothing here takes action; it only scores and explains.
 *
 * Deliberately stateless: recomputed fresh on every request from
 * `guild.members.cache` + a handful of batched (not per-member) queries, so
 * it never goes stale and needs no migration/schema of its own.
 */

export type WatchdogTier = "low" | "watch" | "elevated" | "critical";

export type WatchdogReason = {
  label: string;
  points: number;
};

export type WatchdogUser = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  score: number;
  tier: WatchdogTier;
  reasons: WatchdogReason[];
  accountCreatedAt: string;
  joinedAt: string | null;
  strikes: number;
  activeModCases: number;
  totalModCases: number;
  messagesInGuild: number;
  /** True when this user's message-content retention is 0 — content-based signals were skipped for them. */
  contentSkipped: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Scam/phishing phrasing that isn't ordinary profanity — nitro-gifting and
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

export function tierFor(score: number): WatchdogTier {
  if (score >= 75) return "critical";
  if (score >= 50) return "elevated";
  if (score >= 25) return "watch";
  return "low";
}

function ageInDays(msSince: number): number {
  return msSince / DAY_MS;
}

/** Account-age signal: newer accounts are riskier, decaying to 0 by ~180 days old. */
export function scoreAccountAge(createdAt: number, now: number): WatchdogReason | null {
  const days = ageInDays(now - createdAt);
  if (days < 1) return { label: "Account created within the last 24 hours", points: 30 };
  if (days < 7) return { label: "Account is less than a week old", points: 22 };
  if (days < 30) return { label: "Account is less than a month old", points: 12 };
  if (days < 180) return { label: "Account is less than 6 months old", points: 5 };
  return null;
}

/** Classic raid/bot pattern: the account was created right before it joined this server. */
export function scoreJoinGap(createdAt: number, joinedAt: number | null): WatchdogReason | null {
  if (joinedAt == null) return null;
  const gapMs = joinedAt - createdAt;
  if (gapMs < 0) return null;
  if (gapMs < 60 * 60 * 1000) {
    return { label: "Joined this server within an hour of account creation", points: 20 };
  }
  if (gapMs < DAY_MS) {
    return { label: "Joined this server within a day of account creation", points: 10 };
  }
  return null;
}

function scoreAvatar(member: GuildMember): WatchdogReason | null {
  return member.user.avatar === null
    ? { label: "Using the default Discord avatar", points: 6 }
    : null;
}

// Bulk-generated accounts commonly get handles like "user8271" or
// "xj4k2p9931" — a short run of letters followed by a long run of digits,
// or a name with no vowels at all. Deliberately conservative to avoid
// flagging normal handles like "player1" or "cool_guy22".
const SUSPICIOUS_USERNAME_RE = /^[a-z]{1,6}\d{4,}$/i;
const NO_VOWEL_RE = /^[^aeiou\s]{6,}$/i;

export function scoreUsername(username: string): WatchdogReason | null {
  if (SUSPICIOUS_USERNAME_RE.test(username) || NO_VOWEL_RE.test(username)) {
    return { label: "Username matches a bulk-generated handle pattern", points: 8 };
  }
  return null;
}

function scoreRoles(member: GuildMember): WatchdogReason | null {
  return member.roles.cache.size <= 1
    ? { label: "Has no roles beyond the default @everyone", points: 5 }
    : null;
}

export function scoreStrikes(count: number): WatchdogReason | null {
  if (count <= 0) return null;
  const points = Math.min(35, count * 12);
  return { label: `${count} automod strike${count === 1 ? "" : "s"} on record`, points };
}

export function scoreModCases(active: number, total: number): WatchdogReason | null {
  if (total <= 0) return null;
  const points = Math.min(40, active * 18 + Math.max(0, total - active) * 6);
  if (points <= 0) return null;
  return {
    label:
      active > 0
        ? `${active} active moderation case${active === 1 ? "" : "s"} (${total} total)`
        : `${total} past moderation case${total === 1 ? "" : "s"}`,
    points,
  };
}

/** Many messages in the first few minutes after joining — spam/raid-bot posting pattern. */
export function scoreJoinBurst(
  joinedAt: number | null,
  trail: Array<{ startedAt: Date; messageCount: number }>,
): WatchdogReason | null {
  if (joinedAt == null || trail.length === 0) return null;
  const windowEnd = joinedAt + 5 * 60 * 1000;
  const burst = trail
    .filter((row) => row.startedAt.getTime() <= windowEnd)
    .reduce((sum, row) => sum + row.messageCount, 0);
  if (burst >= 15) return { label: "Sent 15+ messages within 5 minutes of joining", points: 25 };
  if (burst >= 6) return { label: "Sent 6+ messages within 5 minutes of joining", points: 12 };
  return null;
}

/** Self-bot / advertising pattern: the same text posted across multiple channels. */
export function scoreDuplicateContent(
  trail: Array<{ channelId: string; snippet: string }>,
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
    return { label: "Posted identical content across 3+ channels", points: 22 };
  }
  if (maxChannels >= 2) {
    return { label: "Posted identical content across multiple channels", points: 12 };
  }
  return null;
}

export function scoreKeywordHits(
  trail: Array<{ snippet: string }>,
): { scam: WatchdogReason | null; profanity: WatchdogReason | null } {
  const text = trail.map((row) => row.snippet).join(" \n ");
  if (!text.trim()) return { scam: null, profanity: null };

  const scamHits = matchWordPack(text, SCAM_KEYWORDS);
  const scam =
    scamHits.length > 0
      ? { label: `Recent messages contain scam-style phrasing ("${scamHits[0]}")`, points: 28 }
      : null;

  const profanityHits = matchWordPack(text, [...PROFANITY_WORDS, ...SLUR_WORDS]);
  const profanity =
    profanityHits.length >= 3
      ? { label: "Repeated profanity/slurs in recent messages", points: 15 }
      : profanityHits.length > 0
        ? { label: "Profanity in recent messages", points: 6 }
        : null;

  return { scam, profanity };
}

export function scoreGlobalStanding(
  createdAt: number,
  now: number,
  globalCount: number,
): WatchdogReason | null {
  const days = ageInDays(now - createdAt);
  if (days < 14 && globalCount <= 2) {
    return { label: "Almost no message history anywhere on the platform", points: 10 };
  }
  return null;
}

async function batchModStrikes(guildId: string): Promise<Map<string, number>> {
  const rows = await getDb().select().from(modStrikes).where(eq(modStrikes.guildId, guildId)).all();
  return new Map(rows.map((row) => [row.userId, row.count]));
}

async function batchModCases(
  guildId: string,
): Promise<Map<string, { active: number; total: number }>> {
  const rows = await getDb().select().from(modCases).where(eq(modCases.guildId, guildId)).all();
  const map = new Map<string, { active: number; total: number }>();
  for (const row of rows) {
    const entry = map.get(row.userId) ?? { active: 0, total: 0 };
    entry.total += 1;
    if (row.active) entry.active += 1;
    map.set(row.userId, entry);
  }
  return map;
}

/** Trail rows from the last 14 days per user — enough for join-burst and duplicate-content checks. */
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

async function batchContentRetention(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ userId: userProfiles.userId, days: userProfiles.contentRetentionDays })
    .from(userProfiles)
    .where(inArray(userProfiles.userId, userIds))
    .all();
  return new Map(rows.map((row) => [row.userId, row.days]));
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

const MAX_SCORED_MEMBERS = 3000;

type TrailRow = { channelId: string; startedAt: Date; messageCount: number; snippet: string };

/**
 * Shared scoring core — combines one member's signals into a `WatchdogUser`.
 * Used by both `buildWatchdogList` (batched, whole guild, for the dashboard)
 * and `scoreWatchdogMember` (single user, for `/watchdog`) so the two never
 * drift apart: same weights, same reasons, same tiers everywhere.
 */
function composeWatchdogUser(
  member: GuildMember,
  now: number,
  strikeCount: number,
  caseInfo: { active: number; total: number },
  trail: TrailRow[],
  retentionDays: number,
  globalCount: number,
): WatchdogUser {
  const createdAt = member.user.createdTimestamp;
  const joinedAt = member.joinedTimestamp ?? null;
  const contentSkipped = retentionDays <= 0;

  const reasons: (WatchdogReason | null)[] = [
    scoreAccountAge(createdAt, now),
    scoreJoinGap(createdAt, joinedAt),
    scoreAvatar(member),
    scoreUsername(member.user.username),
    scoreRoles(member),
    scoreStrikes(strikeCount),
    scoreModCases(caseInfo.active, caseInfo.total),
    scoreGlobalStanding(createdAt, now, globalCount),
  ];

  if (!contentSkipped) {
    reasons.push(scoreJoinBurst(joinedAt, trail), scoreDuplicateContent(trail));
    const { scam, profanity } = scoreKeywordHits(trail);
    reasons.push(scam, profanity);
  }

  const finalReasons = reasons.filter((r): r is WatchdogReason => r !== null);
  const rawScore = finalReasons.reduce((sum, r) => sum + r.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const messagesInGuild = trail.reduce((sum, row) => sum + row.messageCount, 0);

  return {
    userId: member.id,
    username: member.user.username,
    displayName: member.displayName,
    avatarUrl: member.user.displayAvatarURL({ size: 128 }),
    score,
    tier: tierFor(score),
    reasons: finalReasons.sort((a, b) => b.points - a.points),
    accountCreatedAt: new Date(createdAt).toISOString(),
    joinedAt: joinedAt != null ? new Date(joinedAt).toISOString() : null,
    strikes: strikeCount,
    activeModCases: caseInfo.active,
    totalModCases: caseInfo.total,
    messagesInGuild,
    contentSkipped,
  };
}

/**
 * Builds the ranked risk list for a guild. Only fetches the full member list
 * when the cache is small (mirrors `buildEntities` in dashboardBridge.ts) —
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

  const [strikes, cases, trails, retention, globalCounts] = await Promise.all([
    batchModStrikes(guild.id),
    batchModCases(guild.id),
    batchUserTrail(guild.id),
    batchContentRetention(userIds),
    batchGlobalMessageCounts(userIds),
  ]);

  const now = Date.now();

  const scored: WatchdogUser[] = members.map((member) =>
    composeWatchdogUser(
      member,
      now,
      strikes.get(member.id) ?? 0,
      cases.get(member.id) ?? { active: 0, total: 0 },
      trails.get(member.id) ?? [],
      retention.get(member.id) ?? DEFAULT_CONTENT_RETENTION_DAYS,
      globalCounts.get(member.id) ?? 0,
    ),
  );

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SCORED_MEMBERS);
}

/** Same scoring as `buildWatchdogList`, for exactly one member — used by `/watchdog` in Discord. */
export async function scoreWatchdogMember(member: GuildMember): Promise<WatchdogUser> {
  const guildId = member.guild.id;
  const userId = member.id;
  const since = new Date(Date.now() - 14 * DAY_MS);

  const [strikeRow, caseRows, trailRows, retentionRow, globalRow] = await Promise.all([
    getDb()
      .select({ count: modStrikes.count })
      .from(modStrikes)
      .where(and(eq(modStrikes.guildId, guildId), eq(modStrikes.userId, userId)))
      .get(),
    getDb()
      .select({ active: modCases.active })
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
    getDb()
      .select({ days: userProfiles.contentRetentionDays })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .get(),
    getDb()
      .select({ count: userMessageCounts.count })
      .from(userMessageCounts)
      .where(eq(userMessageCounts.userId, userId))
      .get(),
  ]);

  const caseInfo = caseRows.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.active) acc.active += 1;
      return acc;
    },
    { active: 0, total: 0 },
  );

  return composeWatchdogUser(
    member,
    Date.now(),
    strikeRow?.count ?? 0,
    caseInfo,
    trailRows,
    retentionRow?.days ?? DEFAULT_CONTENT_RETENTION_DAYS,
    globalRow?.count ?? 0,
  );
}
