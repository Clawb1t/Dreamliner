import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { botTranslations } from "../db/schema.js";
import {
  createLanguage,
  deleteLanguage,
  getBulkTranslateStatus,
  getUserLocale,
  invalidateCatalogCache,
  listEnabledLanguages,
  listLanguages,
  setUserLocale,
  startBulkTranslate,
  updateLanguage,
  type BulkTranslateStatus,
  type LanguageRecord,
} from "../i18n/index.js";

export type LanguageOptionForWeb = { id: string; label: string };

export function listLanguagesForWeb(): Promise<LanguageOptionForWeb[]> {
  return listEnabledLanguages().then((langs) => langs.map((l) => ({ id: l.code, label: l.name })));
}

export async function getLanguageForWeb(discordId: string): Promise<{ locale: string }> {
  return { locale: await getUserLocale(discordId) };
}

export async function setLanguageForWeb(discordId: string, locale: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return setUserLocale(discordId, locale);
}

// --- Platform superuser: language + dictionary management (dashboard "Platform > Languages") ---

export async function listAllLanguagesForWeb(): Promise<LanguageRecord[]> {
  return listLanguages();
}

export async function createLanguageForWeb(
  code: string,
  name: string,
  flag: string,
): Promise<{ ok: true; language: LanguageRecord } | { ok: false; error: string }> {
  return createLanguage(code, name, flag);
}

export async function updateLanguageForWeb(
  code: string,
  patch: { name?: string; flag?: string; enabled?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  return updateLanguage(code, patch);
}

export async function deleteLanguageForWeb(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return deleteLanguage(code);
}

export type TranslationEntryForWeb = { key: string; value: string; updatedAt: string };

export async function listTranslationsForWeb(locale: string): Promise<TranslationEntryForWeb[]> {
  const rows = await getDb().select().from(botTranslations).where(eq(botTranslations.locale, locale)).all();
  return rows
    .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updatedAt.toISOString() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export async function setTranslationForWeb(
  locale: string,
  key: string,
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmedKey = key.trim();
  if (!trimmedKey) return { ok: false, error: "Key is required." };
  if (locale === "en") return { ok: false, error: "English has no dictionary — it's the inline fallback text." };

  const languages = await listLanguages();
  if (!languages.some((l) => l.code === locale)) {
    return { ok: false, error: `Language "${locale}" not found.` };
  }

  await getDb()
    .insert(botTranslations)
    .values({ locale, key: trimmedKey, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [botTranslations.locale, botTranslations.key],
      set: { value, updatedAt: new Date() },
    });
  invalidateCatalogCache(locale);
  return { ok: true };
}

export async function deleteTranslationForWeb(locale: string, key: string): Promise<{ ok: true }> {
  await getDb().delete(botTranslations).where(and(eq(botTranslations.locale, locale), eq(botTranslations.key, key)));
  invalidateCatalogCache(locale);
  return { ok: true };
}

/** Kicks off (or reports on) machine-translating every manifest key into `locale` via Google
 *  Translate's free endpoint — see src/i18n/bulkTranslate.ts. */
export function startBulkTranslateForWeb(locale: string): { ok: true } | { ok: false; error: string } {
  if (locale === "en") return { ok: false, error: "English has no dictionary — it's the inline fallback text." };
  startBulkTranslate(locale);
  return { ok: true };
}

export function getBulkTranslateStatusForWeb(locale: string): BulkTranslateStatus {
  return getBulkTranslateStatus(locale);
}
