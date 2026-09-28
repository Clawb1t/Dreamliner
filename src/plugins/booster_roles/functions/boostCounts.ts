import {
  ChannelType,
  MessageType,
  SystemChannelFlagsBitField,
  type Guild,
  type GuildMember,
  type Message,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { boosterBoostBackfills, boosterBoostCounts } from "../../../db/schema.js";

/**
 * Per-member boost counts for Booster Roles' boost-count tiers.
 *
 * Discord's API has no "how many boosts has this member given" field; bots only see when a member
 * started boosting (`premiumSince`). The one source of the count is the announcement Discord posts
 * in the system channel for every boost: it's authored by the booster, and its content is the
 * number of boosts in that event. So counts come from those announcements, live and via a backfill.
 *
 * Only announcements from the member's current boosting streak count: `premiumSince` stays put
 * while they keep at least one boost running, and changes when they stop entirely and later boost
 * again, which starts the count over. Anyone boosting counts as at least 1. A member removing one
 * of several boosts isn't visible to bots, so counts only reset when boosting stops entirely.
 */

const BOOST_MESSAGE_TYPES = new Set<MessageType>([
  MessageType.GuildBoost,
  MessageType.GuildBoostTier1,
  MessageType.GuildBoostTier2,
  MessageType.GuildBoostTier3,
]);

/** Slack for clock differences between `premiumSince` and the announcement's timestamp. */
const STREAK_TOLERANCE_MS = 10 * 60_000;
/** Most messages one backfill reads (100 per request). */
export const BACKFILL_MAX_MESSAGES = 20_000;

export function isBoostAnnouncement(message: Pick<Message, "type">): boolean {
  return BOOST_MESSAGE_TYPES.has(message.type);
}

/** Boosts in one announcement: Discord puts the number in the content when it's more than one. */
export function boostsInAnnouncement(content: string): number {
  const n = Number.parseInt(content.trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 1;
}

function inStreak(at: Date, premiumSince: Date): boolean {
  return at.getTime() >= premiumSince.getTime() - STREAK_TOLERANCE_MS;
}

type CountRow = typeof boosterBoostCounts.$inferSelect;

async function getRow(guildId: string, userId: string): Promise<CountRow | undefined> {
  return getDb()
    .select()
    .from(boosterBoostCounts)
    .where(and(eq(boosterBoostCounts.guildId, guildId), eq(boosterBoostCounts.userId, userId)))
    .get();
}

async function writeRow(guildId: string, userId: string, boosts: number, lastMessageId: string | null): Promise<void> {
  const values = { guildId, userId, boosts, lastMessageId, updatedAt: new Date() };
  await getDb()
    .insert(boosterBoostCounts)
    .values(values)
    .onConflictDoUpdate({
      target: [boosterBoostCounts.guildId, boosterBoostCounts.userId],
      set: { boosts, lastMessageId, updatedAt: values.updatedAt },
    });
}

/** The boost count a member's tiers are judged on: 0 when not boosting, otherwise at least 1. */
export async function effectiveBoostCount(member: GuildMember): Promise<number> {
  const since = member.premiumSince;
  if (!since) return 0;
  const row = await getRow(member.guild.id, member.id);
  // A count last touched before this streak began belongs to an earlier streak.
  if (!row || !inStreak(row.updatedAt, since)) return 1;
  return Math.max(1, row.boosts);
}

/** Counts a live boost announcement toward its author. Returns the member when it counted. */
export async function recordBoostAnnouncement(message: Message): Promise<GuildMember | null> {
  if (!message.guild || !isBoostAnnouncement(message)) return null;
  // Fetched fresh: the announcement can arrive before the member update carrying premiumSince.
  const member = await message.guild.members.fetch({ user: message.author.id, force: true }).catch(() => null);
  if (!member) return null;
  const since = member.premiumSince ?? message.createdAt;

  const row = await getRow(message.guild.id, member.id);
  if (row?.lastMessageId === message.id) return member;
  const current = row && inStreak(row.updatedAt, since) ? row.boosts : 0;
  await writeRow(message.guild.id, member.id, current + boostsInAnnouncement(message.content), message.id);
  return member;
}

/** Clears a member's count once they stop boosting, so a later streak starts from zero. */
export async function resetBoostCount(guildId: string, userId: string): Promise<void> {
  await getDb()
    .delete(boosterBoostCounts)
    .where(and(eq(boosterBoostCounts.guildId, guildId), eq(boosterBoostCounts.userId, userId)));
}

export type BoostCountingStatus = {
  /** Where Discord posts boost announcements, or null when the server has no system channel. */
  channelId: string | null;
  /** False when the server turned off "Send a message when someone boosts this server". */
  announcementsOn: boolean;
  lastBackfill: {
    channelId: string;
    scannedMessages: number;
    boostMessages: number;
    oldestMessageAt: string | null;
    finishedAt: string;
  } | null;
};

export async function getBoostCountingStatus(guild: Guild): Promise<BoostCountingStatus> {
  const backfill = await getDb()
    .select()
    .from(boosterBoostBackfills)
    .where(eq(boosterBoostBackfills.guildId, guild.id))
    .get();
  return {
    channelId: guild.systemChannelId,
    announcementsOn:
      guild.systemChannelId !== null &&
      !guild.systemChannelFlags.has(SystemChannelFlagsBitField.Flags.SuppressPremiumSubscriptions),
    lastBackfill: backfill
      ? {
          channelId: backfill.channelId,
          scannedMessages: backfill.scannedMessages,
          boostMessages: backfill.boostMessages,
          oldestMessageAt: backfill.oldestMessageAt?.toISOString() ?? null,
          finishedAt: backfill.finishedAt.toISOString(),
        }
      : null,
  };
}

export type BackfillResult =
  | { ok: true; scannedMessages: number; boostMessages: number; membersCounted: number }
  | { ok: false; error: "no_channel" | "no_access" };

/**
 * Rebuilds every current booster's count from past boost announcements in the system channel.
 * Stops once it's older than the oldest current boosting streak (nothing earlier can count), or at
 * BACKFILL_MAX_MESSAGES. Replaces counts rather than adding, so it's safe to run again.
 */
export async function backfillBoostCounts(guild: Guild): Promise<BackfillResult> {
  const channel = guild.systemChannel;
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    return { ok: false, error: "no_channel" };
  }

  const members = await guild.members.fetch().catch(() => null);
  const boosters = new Map<string, Date>();
  for (const member of members?.values() ?? []) {
    if (member.premiumSince) boosters.set(member.id, member.premiumSince);
  }
  const oldestStreak = Math.min(...[...boosters.values()].map((d) => d.getTime()), Date.now());

  const counts = new Map<string, { boosts: number; lastMessageId: string }>();
  let scanned = 0;
  let boostMessages = 0;
  let oldest: Date | null = null;
  let before: string | undefined;

  while (scanned < BACKFILL_MAX_MESSAGES) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!page) {
      if (scanned === 0) return { ok: false, error: "no_access" };
      break;
    }
    if (page.size === 0) break;
    for (const message of page.values()) {
      scanned++;
      oldest = message.createdAt;
      if (!isBoostAnnouncement(message)) continue;
      boostMessages++;
      const since = boosters.get(message.author.id);
      if (!since || !inStreak(message.createdAt, since)) continue;
      const entry = counts.get(message.author.id);
      // Pages come newest first, so the first announcement seen per member is their latest.
      counts.set(message.author.id, {
        boosts: (entry?.boosts ?? 0) + boostsInAnnouncement(message.content),
        lastMessageId: entry?.lastMessageId ?? message.id,
      });
    }
    before = page.lastKey();
    if (oldest && oldest.getTime() < oldestStreak - STREAK_TOLERANCE_MS) break;
  }

  for (const [userId, entry] of counts) {
    await writeRow(guild.id, userId, entry.boosts, entry.lastMessageId);
  }
  await getDb()
    .insert(boosterBoostBackfills)
    .values({
      guildId: guild.id,
      channelId: channel.id,
      scannedMessages: scanned,
      boostMessages,
      oldestMessageAt: oldest,
      finishedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: boosterBoostBackfills.guildId,
      set: { channelId: channel.id, scannedMessages: scanned, boostMessages, oldestMessageAt: oldest, finishedAt: new Date() },
    });

  return { ok: true, scannedMessages: scanned, boostMessages, membersCounted: counts.size };
}
