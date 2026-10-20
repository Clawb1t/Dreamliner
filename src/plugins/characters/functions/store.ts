import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { characterMemoryResets, characters, charactersUsageDaily } from "../../../db/schema.js";
import { capMap } from "../../../core/mapPrune.js";
import {
  CATCHPHRASE_LIMITS,
  CHARACTER_TONES,
  EMOJI_USES,
  FORMALITIES,
  REPLY_STYLES,
  type CharacterTone,
  type EmojiUse,
  type Formality,
  type ReplyStyle,
} from "../constants.js";

/** Storage for Characters: definitions (cached per guild), memory resets and daily usage. */

export type CharacterRecord = {
  id: number;
  guildId: string;
  name: string;
  avatarAssetId: string | null;
  avatarUrl: string | null;
  tagline: string;
  personality: string;
  scenario: string;
  greeting: string;
  exampleDialogue: string;
  replyStyle: ReplyStyle;
  temperature: number;
  tone: CharacterTone;
  emojiUse: EmojiUse;
  formality: Formality;
  roleplayActions: boolean;
  catchphrases: string[];
  roleId: string | null;
  roleColor: number | null;
  dedicatedChannelIds: string[];
  allowedChannelIds: string[];
  enabled: boolean;
  reviewStatus: "approved" | "rejected";
  reviewReason: string | null;
  reviewedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type Row = typeof characters.$inferSelect;

function parseIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Catchphrases from the JSON column: strings only, trimmed, capped. */
export function parseCatchphrases(raw: string): string[] {
  return parseIds(raw)
    .map((p) => p.trim().slice(0, CATCHPHRASE_LIMITS.length))
    .filter(Boolean)
    .slice(0, CATCHPHRASE_LIMITS.count);
}

function toRecord(row: Row): CharacterRecord {
  return {
    ...row,
    tone: (CHARACTER_TONES as readonly string[]).includes(row.tone) ? (row.tone as CharacterTone) : "",
    emojiUse: (EMOJI_USES as readonly string[]).includes(row.emojiUse) ? (row.emojiUse as EmojiUse) : "some",
    formality: (FORMALITIES as readonly string[]).includes(row.formality) ? (row.formality as Formality) : "balanced",
    catchphrases: parseCatchphrases(row.catchphrases),
    replyStyle: (REPLY_STYLES as readonly string[]).includes(row.replyStyle) ? (row.replyStyle as ReplyStyle) : "medium",
    dedicatedChannelIds: parseIds(row.dedicatedChannelIds),
    allowedChannelIds: parseIds(row.allowedChannelIds),
    reviewStatus: row.reviewStatus === "rejected" ? "rejected" : "approved",
  };
}

// --- Per-guild cache: MessageCreate looks characters up for every message ----------------------

const cache = new Map<string, CharacterRecord[]>();

function invalidate(guildId: string): void {
  cache.delete(guildId);
}

/** Every character in the guild (cached; cleared on any write). Oldest first. */
export function listCharacters(guildId: string): CharacterRecord[] {
  const hit = cache.get(guildId);
  if (hit) return hit;
  const rows = getDb().select().from(characters).where(eq(characters.guildId, guildId)).orderBy(characters.id).all().map(toRecord);
  cache.set(guildId, rows);
  capMap(cache, 5000);
  return rows;
}

export function getCharacter(guildId: string, id: number): CharacterRecord | null {
  return listCharacters(guildId).find((c) => c.id === id) ?? null;
}

export function characterByRole(guildId: string, roleId: string): CharacterRecord | null {
  return listCharacters(guildId).find((c) => c.roleId === roleId) ?? null;
}

export function charactersByDedicatedChannel(guildId: string, channelId: string): CharacterRecord[] {
  return listCharacters(guildId).filter((c) => c.dedicatedChannelIds.includes(channelId));
}

export function countCharacters(guildId: string): number {
  return listCharacters(guildId).length;
}

export type CharacterWrite = {
  name: string;
  avatarAssetId: string | null;
  avatarUrl: string | null;
  tagline: string;
  personality: string;
  scenario: string;
  greeting: string;
  exampleDialogue: string;
  replyStyle: ReplyStyle;
  temperature: number;
  tone: CharacterTone;
  emojiUse: EmojiUse;
  formality: Formality;
  roleplayActions: boolean;
  catchphrases: string[];
  roleColor: number | null;
  dedicatedChannelIds: string[];
  allowedChannelIds: string[];
  enabled: boolean;
  reviewStatus: "approved" | "rejected";
  reviewReason: string | null;
  reviewedAt: Date | null;
};

function toColumns(input: Partial<CharacterWrite>): Partial<Row> {
  const { dedicatedChannelIds, allowedChannelIds, catchphrases, ...rest } = input;
  const set: Partial<Row> = { ...rest };
  if (catchphrases !== undefined) set.catchphrases = JSON.stringify(catchphrases);
  if (dedicatedChannelIds !== undefined) set.dedicatedChannelIds = JSON.stringify(dedicatedChannelIds);
  if (allowedChannelIds !== undefined) set.allowedChannelIds = JSON.stringify(allowedChannelIds);
  return set;
}

export function createCharacter(guildId: string, createdBy: string, input: CharacterWrite): CharacterRecord {
  const now = new Date();
  const row = getDb()
    .insert(characters)
    .values({
      ...(toColumns(input) as Omit<Row, "id" | "guildId" | "createdBy" | "createdAt" | "updatedAt">),
      guildId,
      createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  invalidate(guildId);
  return toRecord(row);
}

export function updateCharacter(guildId: string, id: number, patch: Partial<CharacterWrite>): CharacterRecord | null {
  const row = getDb()
    .update(characters)
    .set({ ...toColumns(patch), updatedAt: new Date() })
    .where(and(eq(characters.guildId, guildId), eq(characters.id, id)))
    .returning()
    .get();
  invalidate(guildId);
  return row ? toRecord(row) : null;
}

export function setCharacterRole(guildId: string, id: number, roleId: string | null): void {
  getDb()
    .update(characters)
    .set({ roleId })
    .where(and(eq(characters.guildId, guildId), eq(characters.id, id)))
    .run();
  invalidate(guildId);
}

/** A Discord role was deleted: forget it on whichever character used it. */
export function clearDeletedRole(guildId: string, roleId: string): boolean {
  if (!listCharacters(guildId).some((c) => c.roleId === roleId)) return false;
  getDb()
    .update(characters)
    .set({ roleId: null })
    .where(and(eq(characters.guildId, guildId), eq(characters.roleId, roleId)))
    .run();
  invalidate(guildId);
  return true;
}

export function deleteCharacter(guildId: string, id: number): CharacterRecord | null {
  const row = getDb()
    .delete(characters)
    .where(and(eq(characters.guildId, guildId), eq(characters.id, id)))
    .returning()
    .get();
  if (row) getDb().delete(characterMemoryResets).where(eq(characterMemoryResets.characterId, id)).run();
  invalidate(guildId);
  return row ? toRecord(row) : null;
}

// --- Memory resets ---------------------------------------------------------------------------

export function setMemoryReset(characterId: number, channelId: string, at = new Date()): void {
  getDb()
    .insert(characterMemoryResets)
    .values({ characterId, channelId, resetAt: at })
    .onConflictDoUpdate({ target: [characterMemoryResets.characterId, characterMemoryResets.channelId], set: { resetAt: at } })
    .run();
}

export function getMemoryReset(characterId: number, channelId: string): Date | null {
  const row = getDb()
    .select({ resetAt: characterMemoryResets.resetAt })
    .from(characterMemoryResets)
    .where(and(eq(characterMemoryResets.characterId, characterId), eq(characterMemoryResets.channelId, channelId)))
    .get();
  return row?.resetAt ?? null;
}

// --- Daily usage -----------------------------------------------------------------------------

/** The UTC day key, the same as the stats tables use. */
export function usageDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function getUsage(guildId: string, day = usageDay()): { replies: number; tokensIn: number; tokensOut: number } {
  const row = getDb()
    .select()
    .from(charactersUsageDaily)
    .where(and(eq(charactersUsageDaily.guildId, guildId), eq(charactersUsageDaily.day, day)))
    .get();
  return { replies: row?.replies ?? 0, tokensIn: row?.tokensIn ?? 0, tokensOut: row?.tokensOut ?? 0 };
}

/**
 * Takes one of today's replies if the guild is still under `limit`, in one transaction, so
 * concurrent replies can never overshoot. Returns whether it was taken.
 */
export function takeUsage(guildId: string, limit: number, day = usageDay()): boolean {
  return getDb().transaction((tx) => {
    const row = tx
      .select({ used: charactersUsageDaily.replies })
      .from(charactersUsageDaily)
      .where(and(eq(charactersUsageDaily.guildId, guildId), eq(charactersUsageDaily.day, day)))
      .get();
    if ((row?.used ?? 0) >= limit) return false;
    tx.insert(charactersUsageDaily)
      .values({ guildId, day, replies: 1 })
      .onConflictDoUpdate({
        target: [charactersUsageDaily.guildId, charactersUsageDaily.day],
        set: { replies: sql`${charactersUsageDaily.replies} + 1` },
      })
      .run();
    return true;
  });
}

/** Gives back a reply taken by takeUsage when nothing was posted in the end. */
export function refundUsage(guildId: string, day = usageDay()): void {
  getDb()
    .update(charactersUsageDaily)
    .set({ replies: sql`max(0, ${charactersUsageDaily.replies} - 1)` })
    .where(and(eq(charactersUsageDaily.guildId, guildId), eq(charactersUsageDaily.day, day)))
    .run();
}

export function addTokens(guildId: string, tokensIn: number, tokensOut: number, day = usageDay()): void {
  getDb()
    .insert(charactersUsageDaily)
    .values({ guildId, day, tokensIn, tokensOut })
    .onConflictDoUpdate({
      target: [charactersUsageDaily.guildId, charactersUsageDaily.day],
      set: {
        tokensIn: sql`${charactersUsageDaily.tokensIn} + ${tokensIn}`,
        tokensOut: sql`${charactersUsageDaily.tokensOut} + ${tokensOut}`,
      },
    })
    .run();
}
