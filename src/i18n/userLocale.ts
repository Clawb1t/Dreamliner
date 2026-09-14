import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { userLocales } from "../db/schema.js";
import { DEFAULT_LOCALE, type Locale } from "./locale.js";
import { isKnownEnabledLocale } from "./registry.js";

/**
 * A member's personal language preference — global to their Discord account (set with
 * `/language` or from the website account page), not per-guild. Unset means English. Mirrors
 * the pattern in ../plugins/tts/functions/userVoice.ts.
 */
const cache = new Map<string, Locale>();

export async function getUserLocale(userId: string): Promise<Locale> {
  const cached = cache.get(userId);
  if (cached) return cached;

  const row = await getDb().select().from(userLocales).where(eq(userLocales.userId, userId)).get();
  const locale = row?.locale ?? DEFAULT_LOCALE;
  cache.set(userId, locale);
  return locale;
}

export async function setUserLocale(userId: string, locale: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (locale !== DEFAULT_LOCALE && !(await isKnownEnabledLocale(locale))) {
    return { ok: false, error: `"${locale}" isn't an available language.` };
  }
  await getDb()
    .insert(userLocales)
    .values({ userId, locale })
    .onConflictDoUpdate({
      target: [userLocales.userId],
      set: { locale },
    });
  cache.set(userId, locale);
  return { ok: true };
}

export async function clearUserLocale(userId: string): Promise<void> {
  await getDb().delete(userLocales).where(eq(userLocales.userId, userId));
  cache.set(userId, DEFAULT_LOCALE);
}

/** Drops every cached member whose locale is `locale` — used when a superuser deletes a
 *  language, so a member who had it picked shows as English again without a bot restart. */
export function evictUsersOnLocale(locale: string): void {
  for (const [userId, cached] of cache) {
    if (cached === locale) cache.delete(userId);
  }
}
