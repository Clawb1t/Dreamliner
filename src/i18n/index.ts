import type { Locale } from "./locale.js";
import { interpolate, preloadCatalog, translateSync } from "./catalog.js";
import { getUserLocale } from "./userLocale.js";

export { DEFAULT_LOCALE, type Locale } from "./locale.js";
export { getUserLocale, setUserLocale, clearUserLocale, evictUsersOnLocale } from "./userLocale.js";
export { preloadCatalog, invalidateCatalogCache, interpolate, translateSync } from "./catalog.js";
export {
  listLanguages,
  listEnabledLanguages,
  getLanguage,
  isKnownEnabledLocale,
  createLanguage,
  updateLanguage,
  deleteLanguage,
  type LanguageRecord,
} from "./registry.js";
export { startBulkTranslate, getBulkTranslateStatus, type BulkTranslateStatus } from "./bulkTranslate.js";

/**
 * A `t(key, fallback, vars?)` function bound to one locale. `key` is a stable
 * `"namespace.key"` id used to look up the translated string; `fallback` is the English text
 * and is always what's shown for locale "en" or for any key not yet translated. Every plugin
 * should build its replies through this instead of hardcoding English.
 */
export type Translator = (key: string, fallback: string, vars?: Record<string, string | number>) => string;

/** A no-op `Translator` that always shows the English fallback — a safe default parameter value
 *  for helpers mid-migration to `t()` whose every call site hasn't been threaded through yet. */
export const defaultTranslator: Translator = (_key, fallback, vars) => interpolate(fallback, vars);

/**
 * Resolves a member's locale and preloads its dictionary once, then hands back a plain
 * synchronous `t()` closure over that already-loaded dictionary — so every `ctx.t()` call in a
 * plugin stays a cheap sync function call instead of an `await` per string.
 */
export async function translatorFor(userId: string): Promise<{ locale: Locale; t: Translator }> {
  const locale = await getUserLocale(userId);
  const catalog = await preloadCatalog(locale);
  const t: Translator = (key, fallback, vars) => translateSync(locale, key, fallback, catalog, vars);
  return { locale, t };
}
