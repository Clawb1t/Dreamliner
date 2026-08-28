import { z, ZodObject, type ZodType, type ZodTypeAny } from "zod";
import { zInfractionConfig } from "../config/schemas/infraction.js";
import { zAutoroleConfig } from "../config/schemas/autorole.js";
import { zTranslationConfig } from "../config/schemas/translation.js";
import { zStarboardConfig } from "../config/schemas/starboard.js";
import { zReviewsConfig } from "../config/schemas/reviews.js";
import { zSuggestionsConfig } from "../config/schemas/suggestions.js";
import { zTicketsConfig } from "../config/schemas/tickets.js";
import { zScamProtectConfig } from "../config/schemas/scamProtect.js";
import { zPassportConfig } from "../config/schemas/passport.js";
import { zEconomyConfig } from "../config/schemas/economy.js";
import { zUtilityConfig } from "../config/schemas/utility.js";
import {
  zAdminConfig,
  zAutomodConfig,
  zCommandAliasesConfig,
  zCustomEventsConfig,
  zDreamCommandsConfig,
  zLocateUserConfig,
  zMemberIdentityConfig,
  zNameHistoryConfig,
  zPersistConfig,
  zPingableRolesConfig,
  zReactionRolesConfig,
  zRoleButtonsConfig,
  zRoleManagerConfig,
  zRolePanelsConfig,
  zRolesConfig,
  zSelfGrantableRolesConfig,
  zSlowmodeConfig,
  zStatsConfig,
  zUsernameSaverConfig,
  zAutodeleteConfig,
  zAutoreactionsConfig,
  zAutorepliesConfig,
  zAutothreadsConfig,
  zBotCustomisationConfig,
  zCompanionChannelsConfig,
  zCountersConfig,
  zPostConfig,
  zRemindersConfig,
  zTagsConfig,
  zWelcomeMessageConfig,
} from "../config/schemas/plugins.js";

export const pluginConfigSchemas: Record<string, ZodType> = {
  utility: zUtilityConfig,
  infractions: zInfractionConfig,
  autorole: zAutoroleConfig,
  member_identity: zMemberIdentityConfig,
  translation: zTranslationConfig,
  starboard: zStarboardConfig,
  automod: zAutomodConfig,
  scam_protect: zScamProtectConfig,
  passport: zPassportConfig,
  economy: zEconomyConfig,
  admin: zAdminConfig,
  persist: zPersistConfig,
  slowmode: zSlowmodeConfig,
  name_history: zNameHistoryConfig,
  username_saver: zUsernameSaverConfig,
  locate_user: zLocateUserConfig,
  stats: zStatsConfig,
  custom_events: zCustomEventsConfig,
  command_aliases: zCommandAliasesConfig,
  dream_commands: zDreamCommandsConfig,
  roles: zRolesConfig,
  reaction_roles: zReactionRolesConfig,
  role_buttons: zRoleButtonsConfig,
  role_panels: zRolePanelsConfig,
  self_grantable_roles: zSelfGrantableRolesConfig,
  pingable_roles: zPingableRolesConfig,
  role_manager: zRoleManagerConfig,
  welcome_message: zWelcomeMessageConfig,
  tags: zTagsConfig,
  post: zPostConfig,
  autodelete: zAutodeleteConfig,
  autoreactions: zAutoreactionsConfig,
  autoreplies: zAutorepliesConfig,
  autothreads: zAutothreadsConfig,
  reminders: zRemindersConfig,
  counters: zCountersConfig,
  companion_channels: zCompanionChannelsConfig,
  bot_customisation: zBotCustomisationConfig,
  reviews: zReviewsConfig,
  suggestions: zSuggestionsConfig,
  tickets: zTicketsConfig,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginConfigKeySet(schema: ZodType): Set<string> | null {
  if (schema instanceof ZodObject) {
    return new Set(Object.keys(schema.shape as Record<string, unknown>));
  }
  return null;
}

/** Drop leftover keys (old can_* flags, renamed fields) from a merged plugin config. */
export function stripUnknownPluginKeys(pluginName: string, config: Record<string, unknown>): Record<string, unknown> {
  const schema = pluginConfigSchemas[pluginName];
  if (!schema) return config;
  const allowed = pluginConfigKeySet(schema);
  if (!allowed) return config;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (allowed.has(key)) next[key] = value;
  }
  return next;
}

/**
 * Parse a resolved plugin config without throwing.
 * Unknown keys should already be stripped by resolvePluginConfig.
 * If remaining values are invalid, fall back to schema defaults.
 */
export function parsePluginConfig<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data as z.output<S>;
  const fallback = schema.safeParse({});
  if (fallback.success) {
    console.warn(
      `[config] Plugin config was invalid and was reset to defaults: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
    return fallback.data as z.output<S>;
  }
  try {
    return schema.parse({}) as z.output<S>;
  } catch {
    return {} as z.output<S>;
  }
}

/**
 * Remove obsolete keys from plugin `config` and `overrides[].config`.
 * Override records are untyped, so leftover permissions survive guild-schema repair.
 */
export function scrubUnknownPluginConfigKeys(root: Record<string, unknown>): string[] {
  const repairs: string[] = [];
  const plugins = root.plugins;
  if (!isPlainObject(plugins)) return repairs;

  for (const [name, section] of Object.entries(plugins)) {
    if (!isPlainObject(section)) continue;
    const schema = pluginConfigSchemas[name];
    if (!schema) continue;
    const allowed = pluginConfigKeySet(schema);
    if (!allowed) continue;

    if (isPlainObject(section.config)) {
      for (const key of Object.keys(section.config)) {
        if (allowed.has(key)) continue;
        delete section.config[key];
        repairs.push(`plugins.${name}.config.${key}`);
      }
    }

    if (!Array.isArray(section.overrides)) continue;
    const kept: unknown[] = [];
    for (let index = 0; index < section.overrides.length; index += 1) {
      const override = section.overrides[index];
      if (!isPlainObject(override) || !isPlainObject(override.config)) {
        kept.push(override);
        continue;
      }
      for (const key of Object.keys(override.config)) {
        if (allowed.has(key)) continue;
        delete override.config[key];
        repairs.push(`plugins.${name}.overrides.${index}.config.${key}`);
      }
      if (Object.keys(override.config).length === 0) {
        repairs.push(`plugins.${name}.overrides.${index} (removed empty override)`);
        continue;
      }
      kept.push(override);
    }
    section.overrides = kept;
  }

  return repairs;
}

export function getPluginBaseConfig(pluginName: string): Record<string, unknown> {
  const schema = pluginConfigSchemas[pluginName];
  if (!schema) return {};
  return parsePluginConfig(schema, {}) as Record<string, unknown>;
}
