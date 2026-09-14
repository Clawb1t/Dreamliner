import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { botLanguages, botTranslations } from "../db/schema.js";
import { invalidateCatalogCache } from "./catalog.js";
import { readManifest } from "./manifest.js";

export type LanguageRecord = {
  code: string;
  name: string;
  flag: string;
  enabled: boolean;
  builtIn: boolean;
};

/**
 * The set of languages Dreamliner can reply in — "en" plus whatever ja/es/tr/others are rows in
 * `bot_languages`. Cached in-process; the dashboard bridge that edits this table lives in this
 * same process (src/bridge/dashboardBridge.ts), so a superuser's write and `invalidate()` below
 * always happen together — no cross-process staleness to worry about.
 */
let cache: LanguageRecord[] | null = null;

function invalidate(): void {
  cache = null;
}

export async function listLanguages(): Promise<LanguageRecord[]> {
  if (cache) return cache;
  const rows = await getDb().select().from(botLanguages).all();
  const sorted = [...rows].sort((a, b) => {
    if (a.code === "en") return -1;
    if (b.code === "en") return 1;
    return a.name.localeCompare(b.name);
  });
  cache = sorted.map((row) => ({
    code: row.code,
    name: row.name,
    flag: row.flag,
    enabled: row.enabled,
    builtIn: row.builtIn,
  }));
  return cache;
}

export async function listEnabledLanguages(): Promise<LanguageRecord[]> {
  return (await listLanguages()).filter((lang) => lang.enabled);
}

export async function getLanguage(code: string): Promise<LanguageRecord | null> {
  return (await listLanguages()).find((lang) => lang.code === code) ?? null;
}

export async function isKnownEnabledLocale(code: string): Promise<boolean> {
  return (await listEnabledLanguages()).some((lang) => lang.code === code);
}

const CODE_PATTERN = /^[a-z]{2,8}(-[a-z0-9]{2,8})?$/;

export async function createLanguage(
  code: string,
  name: string,
  flag: string,
): Promise<{ ok: true; language: LanguageRecord } | { ok: false; error: string }> {
  const normalizedCode = code.trim().toLowerCase();
  if (!CODE_PATTERN.test(normalizedCode)) {
    return { ok: false, error: "Language code must look like 'de' or 'pt-br' (lowercase letters, digits, one dash)." };
  }
  const trimmedName = name.trim().slice(0, 60);
  if (!trimmedName) {
    return { ok: false, error: "Name is required." };
  }
  const trimmedFlag = flag.trim().slice(0, 8);

  const existing = await getDb().select().from(botLanguages).where(eq(botLanguages.code, normalizedCode)).get();
  if (existing) {
    return { ok: false, error: `Language "${normalizedCode}" already exists.` };
  }

  const createdAt = new Date();
  await getDb().insert(botLanguages).values({
    code: normalizedCode,
    name: trimmedName,
    flag: trimmedFlag,
    enabled: true,
    builtIn: false,
    createdAt,
  });

  // Seed the new language with every known key set to its English fallback text, so it starts
  // as a full (if untranslated) dictionary a superuser edits from, not an empty one.
  const manifest = Object.entries(readManifest());
  if (manifest.length) {
    const now = new Date();
    for (const [key, value] of manifest) {
      await getDb()
        .insert(botTranslations)
        .values({ locale: normalizedCode, key, value, updatedAt: now })
        .onConflictDoNothing({ target: [botTranslations.locale, botTranslations.key] });
    }
  }

  invalidate();
  invalidateCatalogCache(normalizedCode);
  return { ok: true, language: { code: normalizedCode, name: trimmedName, flag: trimmedFlag, enabled: true, builtIn: false } };
}

export async function updateLanguage(
  code: string,
  patch: { name?: string; flag?: string; enabled?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await getDb().select().from(botLanguages).where(eq(botLanguages.code, code)).get();
  if (!existing) return { ok: false, error: `Language "${code}" not found.` };
  if (existing.builtIn && patch.enabled === false && code === "en") {
    return { ok: false, error: "English can't be disabled — it's the built-in fallback for every reply." };
  }

  const set: { name?: string; flag?: string; enabled?: boolean } = {};
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim().slice(0, 60);
    if (!trimmed) return { ok: false, error: "Name is required." };
    set.name = trimmed;
  }
  if (patch.flag !== undefined) set.flag = patch.flag.trim().slice(0, 8);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;

  await getDb().update(botLanguages).set(set).where(eq(botLanguages.code, code));
  invalidate();
  return { ok: true };
}

export async function deleteLanguage(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await getDb().select().from(botLanguages).where(eq(botLanguages.code, code)).get();
  if (!existing) return { ok: false, error: `Language "${code}" not found.` };
  if (existing.builtIn) return { ok: false, error: "Built-in languages can't be deleted — disable them instead." };

  const { botTranslations, userLocales } = await import("../db/schema.js");
  const { evictUsersOnLocale } = await import("./userLocale.js");
  await getDb().delete(botTranslations).where(eq(botTranslations.locale, code));
  // Members who had this language picked fall back to English rather than being left on a
  // locale that no longer exists.
  await getDb().delete(userLocales).where(eq(userLocales.locale, code));
  await getDb().delete(botLanguages).where(eq(botLanguages.code, code));
  invalidate();
  invalidateCatalogCache(code);
  evictUsersOnLocale(code);
  return { ok: true };
}
