import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { zGuildConfig, type GuildConfig } from "./schemas/guild.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedDefault: GuildConfig | null = null;

/**
 * Where the generated default-config snapshot lives (`npm run schema:export` writes it there).
 * Nothing in the bot reads from this path anymore — it exists purely so the external website's
 * GitHub-fallback path (used when the live dashboard bridge is unreachable) still finds a
 * `config/default.server.yaml` at the expected location. The bot's own defaults come from
 * `loadDefaultConfig()` below, computed straight from the zod schemas.
 */
export function getDefaultConfigPath(): string {
  return join(__dirname, "../../config/default.server.yaml");
}

/** The default config as YAML text — used only to populate that generated snapshot file above. */
export function loadDefaultConfigRaw(): string {
  return YAML.stringify(loadDefaultConfig());
}

/**
 * The bot's single source of truth for "what does a guild with no customization run with" —
 * every plugin's on/off-by-default state and every field's default value now live in the zod
 * schemas themselves (`zPluginSection`'s `enabledByDefault`, and each field's own `.default()`),
 * not in a separately-maintained file. `zGuildConfig.parse({})` is guaranteed to succeed (it's
 * exercised by `src/config/validator.test.ts`), which `repairGuildConfig`'s last-resort fallback
 * depends on.
 */
export function loadDefaultConfig(): GuildConfig {
  if (!cachedDefault) {
    cachedDefault = zGuildConfig.parse({});
  }
  return structuredClone(cachedDefault);
}

export function clearDefaultConfigCache() {
  cachedDefault = null;
}
