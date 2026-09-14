import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Every translation key currently used anywhere in the bot, mapped to its English fallback
 *  text — regenerated with `npm run i18n:extract` (scripts/extractI18nKeys.ts). Used to seed a
 *  brand-new language with "everything in English" so a superuser has a full dictionary to edit
 *  from, and to drive the dashboard's "Translate all from English" bulk machine-translate. */
export function readManifest(): Record<string, string> {
  const path = join(__dirname, "../../i18n/locales/manifest.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}
