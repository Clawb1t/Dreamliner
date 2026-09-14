import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { botTranslations } from "../db/schema.js";
import type { Locale } from "./locale.js";

/**
 * Flat `"namespace.key" -> translated string` maps per locale, loaded from the `bot_translations`
 * table and kept in an in-process cache (there's no dictionary for "en" — every t() call site
 * supplies its own English fallback text, see locale.ts). The dashboard bridge that edits this
 * table lives in this same bot process, so a superuser's write invalidates this same cache
 * directly — no cross-process staleness to reconcile.
 */
type Catalog = Record<string, string>;

const catalogCache = new Map<string, Catalog>();
const loading = new Map<string, Promise<Catalog>>();

async function loadCatalog(locale: string): Promise<Catalog> {
  const rows = await getDb().select().from(botTranslations).where(eq(botTranslations.locale, locale)).all();
  const map: Catalog = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

/** Loads (or returns the cached) dictionary for `locale`. English always resolves to `{}`. */
export async function preloadCatalog(locale: Locale): Promise<Catalog> {
  if (locale === "en") return {};
  const cached = catalogCache.get(locale);
  if (cached) return cached;
  let pending = loading.get(locale);
  if (!pending) {
    pending = loadCatalog(locale).then((map) => {
      catalogCache.set(locale, map);
      loading.delete(locale);
      return map;
    });
    loading.set(locale, pending);
  }
  return pending;
}

export function invalidateCatalogCache(locale?: string): void {
  if (locale) catalogCache.delete(locale);
  else catalogCache.clear();
}

/** Fills `{name}`-style placeholders in `template` from `vars`. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Looks up `key` in an already-{@link preloadCatalog}ed dictionary; falls back to `fallback`
 * (the English text, always supplied by the call site) for English or any key not yet
 * translated. Synchronous by design — see i18n/index.ts's `translatorFor`, which preloads the
 * dictionary once per command dispatch so every `ctx.t()` call in a plugin stays a plain sync
 * function call.
 */
export function translateSync(
  locale: Locale,
  key: string,
  fallback: string,
  catalog: Catalog | undefined,
  vars?: Record<string, string | number>,
): string {
  const template = locale === "en" ? fallback : (catalog?.[key] ?? fallback);
  return interpolate(template, vars);
}
