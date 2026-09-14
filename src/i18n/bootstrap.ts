import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/client.js";
import { botLanguages, botTranslations } from "../db/schema.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("i18n");
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Only English is a permanent built-in (it can't be disabled/deleted — see registry.ts). Every
 *  other language, ja/es/tr included, is created from the dashboard like any other and is
 *  freely disable/deletable from there. */
const BUILTIN_LANGUAGES: { code: string; name: string; flag: string; builtIn: boolean }[] = [
  { code: "en", name: "English", flag: "🇬🇧", builtIn: true },
];

function readJsonCatalog(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    const { _comment, ...rest } = raw;
    void _comment;
    return rest;
  } catch (error) {
    log.error(`[i18n] Failed to read seed catalog from ${path}:`, error);
    return {};
  }
}

/**
 * Starter dictionary for the seeded built-ins, merged from `<repo root>/i18n/locales/<code>.json`
 * (the core catalog) plus every `<repo root>/i18n/locales/fragments/*\/<code>.json` (one folder
 * per plugin/batch of plugins translated — keeping each contributor's file separate avoids
 * everyone editing the same JSON file). Same shape a superuser edits from the dashboard. Only
 * used once per key: an existing DB row (including one a superuser has since edited) is never
 * overwritten. */
function readSeedCatalog(code: string): Record<string, string> {
  const merged: Record<string, string> = { ...readJsonCatalog(join(__dirname, "../../i18n/locales", `${code}.json`)) };

  const fragmentsDir = join(__dirname, "../../i18n/locales/fragments");
  if (existsSync(fragmentsDir)) {
    for (const folder of readdirSync(fragmentsDir, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      Object.assign(merged, readJsonCatalog(join(fragmentsDir, folder.name, `${code}.json`)));
    }
  }

  return merged;
}

/**
 * Idempotent boot-time seed: makes sure every entry in {@link BUILTIN_LANGUAGES} (just "en")
 * exists as a `bot_languages` row and that its starter dictionary entries exist, without ever
 * clobbering a row a superuser has since edited or a language they've since disabled/renamed.
 * Safe to call on every boot.
 */
export async function ensureBuiltinLanguages(): Promise<void> {
  const db = getDb();
  const now = new Date();

  for (const lang of BUILTIN_LANGUAGES) {
    await db
      .insert(botLanguages)
      .values({ ...lang, enabled: true, createdAt: now })
      .onConflictDoNothing({ target: botLanguages.code });
  }

  for (const lang of BUILTIN_LANGUAGES) {
    if (lang.code === "en") continue; // English has no dictionary — see locale.ts.
    const entries = Object.entries(readSeedCatalog(lang.code));
    if (!entries.length) continue;
    for (const [key, value] of entries) {
      await db
        .insert(botTranslations)
        .values({ locale: lang.code, key, value, updatedAt: now })
        .onConflictDoNothing({ target: [botTranslations.locale, botTranslations.key] });
    }
  }
}
