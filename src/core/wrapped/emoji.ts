/**
 * Emoji tracking for Dreamliner Wrapped. Counts the emoji a member uses in their messages (unicode
 * and custom) and the reactions they add, per user per UTC year. Only the emoji and a count are
 * kept; the message text is read in memory to find emoji and is never stored.
 *
 * Writes are batched: events add to an in-memory tally that's flushed every few seconds (or sooner
 * once it grows), in one transaction, so a busy server never costs a write per message.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { wrappedEmojiUsage } from "../../db/schema.js";
import { getLogger } from "../logger.js";
import { wrappedYearOf } from "./window.js";

const log = getLogger("wrapped");

/** Most emoji counted from one message (spam guard). */
export const MAX_EMOJI_PER_MESSAGE = 20;
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_AT_ENTRIES = 500;

export type ParsedEmoji = {
  /** Unicode emoji itself, or "c:<id>" for a custom emoji. */
  key: string;
  id: string | null;
  name: string;
  animated: boolean;
};

const CUSTOM_EMOJI = /<(a?):([A-Za-z0-9_~]{1,32}):(\d{15,22})>/g;

/**
 * Unicode emoji: flags (regional indicator pairs), keycaps, and emoji with default emoji
 * presentation or an explicit FE0F, with skin tones, tag sequences and ZWJ joins. Plain text
 * symbols such as © or ™ without FE0F are left out.
 */
const UNICODE_EMOJI =
  /\p{RI}\p{RI}|[#*0-9]️?⃣|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)(?:\p{EMod}|️|[\u{E0020}-\u{E007F}]+)*(?:‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})️?\p{EMod}?)*/gu;

/** Every emoji in a message, in order, up to `limit`. Custom emoji first-class; unicode after. */
export function parseMessageEmoji(content: string, limit = MAX_EMOJI_PER_MESSAGE): ParsedEmoji[] {
  if (!content) return [];
  const found: Array<ParsedEmoji & { at: number }> = [];
  for (const match of content.matchAll(CUSTOM_EMOJI)) {
    found.push({ key: `c:${match[3]!}`, id: match[3]!, name: match[2]!, animated: match[1] === "a", at: match.index ?? 0 });
  }
  // Blank custom emoji out (same length, so positions stay comparable) before the unicode scan.
  const text = content.replace(CUSTOM_EMOJI, (whole) => " ".repeat(whole.length));
  for (const match of text.matchAll(UNICODE_EMOJI)) {
    const value = match[0];
    // A lone skin tone swatch isn't an emoji anyone "used".
    if (/^\p{EMod}$/u.test(value)) continue;
    found.push({ key: value, id: null, name: value, animated: false, at: match.index ?? 0 });
  }
  return found
    .sort((a, b) => a.at - b.at)
    .slice(0, Math.max(0, limit))
    .map(({ at: _at, ...emoji }) => emoji);
}

/** A reaction's emoji in the same shape (discord.js ReactionEmoji / GuildEmoji fields). */
export function reactionEmoji(emoji: { id: string | null; name: string | null; animated?: boolean | null }): ParsedEmoji | null {
  if (emoji.id) return { key: `c:${emoji.id}`, id: emoji.id, name: emoji.name ?? "emoji", animated: Boolean(emoji.animated) };
  if (!emoji.name) return null;
  return { key: emoji.name, id: null, name: emoji.name, animated: false };
}

type Pending = ParsedEmoji & { userId: string; year: number; messages: number; reactions: number };

const pending = new Map<string, Pending>();
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => flushEmojiUsage(), FLUSH_INTERVAL_MS);
  timer.unref?.();
}

/** Adds emoji to the tally. `source` says whether they came from a message or a reaction. */
export function recordEmojiUse(userId: string, emoji: readonly ParsedEmoji[], source: "message" | "reaction", at: Date | number = Date.now()): void {
  if (!userId || emoji.length === 0) return;
  const year = wrappedYearOf(at);
  for (const item of emoji) {
    const mapKey = `${userId}\u0000${year}\u0000${item.key}`;
    let entry = pending.get(mapKey);
    if (!entry) {
      entry = { ...item, userId, year, messages: 0, reactions: 0 };
      pending.set(mapKey, entry);
    } else if (item.id) {
      // Custom emoji can be renamed: keep the latest name.
      entry.name = item.name;
      entry.animated = item.animated;
    }
    if (source === "message") entry.messages += 1;
    else entry.reactions += 1;
  }
  if (pending.size >= FLUSH_AT_ENTRIES) flushEmojiUsage();
  else ensureTimer();
}

/** Writes the tally in one transaction. Never throws. */
export function flushEmojiUsage(): number {
  if (pending.size === 0) return 0;
  const batch = [...pending.values()];
  pending.clear();
  try {
    const db = getDb();
    db.transaction((tx) => {
      for (const row of batch) {
        tx.insert(wrappedEmojiUsage)
          .values({
            userId: row.userId,
            year: row.year,
            emojiKey: row.key,
            emojiId: row.id,
            name: row.name,
            animated: row.animated,
            messageCount: row.messages,
            reactionCount: row.reactions,
          })
          .onConflictDoUpdate({
            target: [wrappedEmojiUsage.userId, wrappedEmojiUsage.year, wrappedEmojiUsage.emojiKey],
            set: {
              name: row.name,
              animated: row.animated,
              messageCount: sql`${wrappedEmojiUsage.messageCount} + ${row.messages}`,
              reactionCount: sql`${wrappedEmojiUsage.reactionCount} + ${row.reactions}`,
            },
          })
          .run();
      }
    });
    return batch.length;
  } catch (error) {
    log.warn(`Failed to write ${batch.length} emoji counts: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
}

/** Drops a user's not-yet-written counts (erase my data), so a later flush can't bring them back. */
export function dropPendingEmojiFor(userId: string): void {
  for (const [key, entry] of pending) if (entry.userId === userId) pending.delete(key);
}

/** Test hook. */
export function pendingEmojiCount(): number {
  return pending.size;
}
