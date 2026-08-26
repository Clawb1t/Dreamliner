import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { userProfiles } from "../db/schema.js";

/**
 * How long a user's message *content* (not their counts/timestamps) stays
 * retained before being scrubbed. `0` means "don't even store it" — write
 * sites should treat it as immediate redaction, not "expires instantly".
 */
export const CONTENT_RETENTION_OPTIONS = [0, 1, 7, 14, 30] as const;
export type ContentRetentionDays = (typeof CONTENT_RETENTION_OPTIONS)[number];
export const DEFAULT_CONTENT_RETENTION_DAYS: ContentRetentionDays = 30;

export const REDACTED_CONTENT_PLACEHOLDER = "[content no longer retained]";

/** `undefined` = field not provided, `null`/number = valid, throws on invalid. */
export function normalizeContentRetentionDays(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!CONTENT_RETENTION_OPTIONS.includes(num as ContentRetentionDays)) {
    throw new Error("contentRetentionDays must be one of 0, 1, 7, 14, or 30.");
  }
  return num;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { value: number; expiresAt: number }>();

/** Cached — this gets checked on essentially every tracked message. */
export async function getContentRetentionDays(userId: string): Promise<number> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const row = await getDb()
    .select({ days: userProfiles.contentRetentionDays })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .get();
  const value = row?.days ?? DEFAULT_CONTENT_RETENTION_DAYS;
  cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function invalidateContentRetentionCache(userId: string): void {
  cache.delete(userId);
}

export function isContentExpired(referenceDate: Date, retentionDays: number): boolean {
  if (retentionDays <= 0) return true;
  const ageMs = Date.now() - referenceDate.getTime();
  return ageMs > retentionDays * 24 * 60 * 60 * 1000;
}
