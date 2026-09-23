import {
  zApplicationsConfig,
  type ApplicationOpening,
  type ApplicationsConfig,
} from "../../../config/schemas/applications.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";

export const PLUGIN = "applications";

export function loadApplicationsConfig(guildConfig: GuildConfig): ApplicationsConfig {
  return parsePluginConfig(zApplicationsConfig, getPluginSettings(guildConfig, PLUGIN));
}

export function findOpening(config: ApplicationsConfig, openingId: string): ApplicationOpening | undefined {
  return config.openings.find((o) => o.id === openingId);
}

export function openingName(opening: Pick<ApplicationOpening, "name">): string {
  return opening.name.trim() || "Application";
}

export function modalTitle(opening: ApplicationOpening): string {
  return (opening.modal_title.trim() || `${openingName(opening)} application`).slice(0, 45);
}

/** The opening's own review channel, else the plugin-wide default. */
export function reviewChannelFor(config: ApplicationsConfig, opening: ApplicationOpening): string | undefined {
  return opening.review_channel_id?.trim() || config.review_channel_id?.trim() || undefined;
}

/** Template vars every Applications message can use on top of the usual {user}/{guild}/... ones. */
export function openingVars(opening: ApplicationOpening): Record<string, string> {
  return { opening: openingName(opening), opening_description: opening.description.trim() };
}
