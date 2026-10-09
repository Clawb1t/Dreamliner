import {
  APPEALABLE_TYPES,
  zAppealsConfig,
  type AppealableType,
  type AppealForm,
  type AppealsConfig,
  type AppealTypeRule,
} from "../../../config/schemas/appeals.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { parseDuration } from "../../infraction/functions/duration.js";

export const PLUGIN = "appeals";

export function loadAppealsConfig(guildConfig: GuildConfig): AppealsConfig {
  return parsePluginConfig(zAppealsConfig, getPluginSettings(guildConfig, PLUGIN));
}

/** The server's appeals config when the plugin is on, else null. */
export function activeAppealsConfig(guildConfig: GuildConfig): AppealsConfig | null {
  return pluginEnabled(guildConfig, PLUGIN) ? loadAppealsConfig(guildConfig) : null;
}

export function isAppealableType(type: string): type is AppealableType {
  return (APPEALABLE_TYPES as readonly string[]).includes(type);
}

export function ruleFor(config: AppealsConfig, type: string): AppealTypeRule | null {
  return isAppealableType(type) ? config.types[type] : null;
}

/** A form by id, falling back to the first form (an empty id means "the first form"). */
export function formById(config: AppealsConfig, formId: string): AppealForm | null {
  return config.forms.find((form) => form.id === formId) ?? config.forms[0] ?? null;
}

/** "24h" style durations in ms; empty or invalid means none (0). */
export function durationMs(value: string): number {
  return value.trim() ? (parseDuration(value) ?? 0) : 0;
}

/** Human labels for infraction types, as appellants see them. */
export const TYPE_LABELS: Record<string, string> = {
  ban: "Ban",
  tempban: "Temporary ban",
  softban: "Softban",
  kick: "Kick",
  mute: "Mute",
  tempmute: "Temporary mute",
  warn: "Warning",
};

export function typeLabel(type: string | null | undefined): string {
  return (type && TYPE_LABELS[type]) || "Infraction";
}
