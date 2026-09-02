import type { GuildMember } from "discord.js";
import { configManager } from "../config/manager.js";
import { getPluginSettings, hasPermission, resolveEffectivePluginConfig } from "./permissionRoles.js";
import { zTranslationConfig, type TranslationConfig } from "../config/schemas/translation.js";
import { parsePluginConfig } from "./pluginSchemas.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import { zStarboardBoard, zStarboardConfig, type StarboardBoard, type StarboardConfig } from "../config/schemas/starboard.js";

export const pluginsRequiringConfig = new Set(["utility", "infractions"]);

/** With a member, resolves permission-aware config (can_* flags included, via Dreamliner Roles). Without one, settings only — used by event handlers and bot-driven actions that have no member to check roles for. */
export async function getUtilityPluginConfig(
  guildId: string,
  guildConfig: GuildConfig,
  member?: GuildMember,
): Promise<Record<string, unknown>> {
  return member ? resolveEffectivePluginConfig(guildId, "utility", member, guildConfig) : getPluginSettings(guildConfig, "utility");
}

export async function getInfractionPluginConfig(
  guildId: string,
  guildConfig: GuildConfig,
  member?: GuildMember,
): Promise<Record<string, unknown>> {
  return member ? resolveEffectivePluginConfig(guildId, "infractions", member, guildConfig) : getPluginSettings(guildConfig, "infractions");
}

export async function getTicketsPluginConfig(
  guildId: string,
  guildConfig: GuildConfig,
  member?: GuildMember,
): Promise<Record<string, unknown>> {
  return member ? resolveEffectivePluginConfig(guildId, "tickets", member, guildConfig) : getPluginSettings(guildConfig, "tickets");
}

export function getAutorolePluginConfig(guildConfig: GuildConfig): Record<string, unknown> {
  return getPluginSettings(guildConfig, "autorole");
}

export function getTranslationPluginConfig(guildConfig: GuildConfig): TranslationConfig {
  return parsePluginConfig(zTranslationConfig, getPluginSettings(guildConfig, "translation"));
}

export function getStarboardPluginConfig(guildConfig: GuildConfig): StarboardConfig {
  const section = guildConfig.plugins.starboard;
  const base = zStarboardConfig.parse({});
  const userConfig = section?.config ?? {};
  const mergedBoards = { ...base.boards, ...(userConfig.boards ?? {}) };

  const boards: Record<string, StarboardBoard> = {};
  for (const [name, board] of Object.entries(mergedBoards)) {
    boards[name] = zStarboardBoard.parse(board);
  }

  return zStarboardConfig.parse({
    ...base,
    ...userConfig,
    boards,
  });
}

export async function canUseUtility(guildId: string, guildConfig: GuildConfig, permission: string, member: GuildMember): Promise<boolean> {
  return hasPermission(guildId, "utility", permission, member, guildConfig);
}

export async function canUseInfractions(guildId: string, guildConfig: GuildConfig, permission: string, member: GuildMember): Promise<boolean> {
  return hasPermission(guildId, "infractions", permission, member, guildConfig);
}

export async function canUseTickets(guildId: string, guildConfig: GuildConfig, permission: string, member: GuildMember): Promise<boolean> {
  return hasPermission(guildId, "tickets", permission, member, guildConfig);
}

export async function ensureGuildConfigured(guildId: string): Promise<boolean> {
  const stored = await configManager.getGuildConfig(guildId);
  return stored !== null;
}
