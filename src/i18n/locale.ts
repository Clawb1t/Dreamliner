/**
 * A locale is just its code (e.g. "en", "ja", "de"). "en" is special-cased everywhere in this
 * module: English text lives inline in code as every `t()` call's fallback, so it has no
 * dictionary row and can't be disabled. Every other locale is a row in `bot_languages` — ja/es/tr
 * ship as seeded built-ins (see i18n/bootstrap.ts), and a platform superuser can add more from
 * the dashboard (Platform > Languages) — see i18n/registry.ts.
 */
export type Locale = string;

export const DEFAULT_LOCALE: Locale = "en";
