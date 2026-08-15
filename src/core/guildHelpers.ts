import { configManager } from "../config/manager.js";
import { hasPluginPermission, resolvePluginConfig } from "../core/permissions.js";
import { utilityDefaultOverrides } from "../plugins/utility/defaultOverrides.js";
import { infractionDefaultOverrides } from "../plugins/infraction/defaultOverrides.js";
import { rolesDefaultOverrides } from "../plugins/roles/defaultOverrides.js";
import { reactionRolesDefaultOverrides } from "../plugins/reaction_roles/defaultOverrides.js";
import { roleButtonsDefaultOverrides } from "../plugins/role_buttons/defaultOverrides.js";
import { selfGrantableRolesDefaultOverrides } from "../plugins/self_grantable_roles/defaultOverrides.js";
import { pingableRolesDefaultOverrides } from "../plugins/pingable_roles/defaultOverrides.js";
import { roleManagerDefaultOverrides } from "../plugins/role_manager/defaultOverrides.js";
import { nameHistoryDefaultOverrides } from "../plugins/name_history/defaultOverrides.js";
import { locateUserDefaultOverrides } from "../plugins/locate_user/defaultOverrides.js";
import { statsDefaultOverrides } from "../plugins/stats/defaultOverrides.js";
import { customEventsDefaultOverrides } from "../plugins/custom_events/defaultOverrides.js";
import { commandAliasesDefaultOverrides } from "../plugins/command_aliases/defaultOverrides.js";
import { automodDefaultOverrides } from "../plugins/automod/defaultOverrides.js";
import { adminDefaultOverrides } from "../plugins/admin/defaultOverrides.js";
import { slowmodeDefaultOverrides } from "../plugins/slowmode/defaultOverrides.js";
import { welcomeMessageDefaultOverrides } from "../plugins/welcome_message/defaultOverrides.js";
import { tagsDefaultOverrides } from "../plugins/tags/defaultOverrides.js";
import { postDefaultOverrides } from "../plugins/post/defaultOverrides.js";
import { autodeleteDefaultOverrides } from "../plugins/autodelete/defaultOverrides.js";
import { autoreactionsDefaultOverrides } from "../plugins/autoreactions/defaultOverrides.js";
import { autorepliesDefaultOverrides } from "../plugins/autoreplies/defaultOverrides.js";
import { autoroleDefaultOverrides } from "../plugins/autorole/defaultOverrides.js";
import { translationDefaultOverrides } from "../plugins/translation/defaultOverrides.js";
import { remindersDefaultOverrides } from "../plugins/reminders/defaultOverrides.js";
import { zTranslationConfig, type TranslationConfig } from "../config/schemas/translation.js";
import { parsePluginConfig } from "./pluginSchemas.js";
import { countersDefaultOverrides } from "../plugins/counters/defaultOverrides.js";
import { dreamCommandsDefaultOverrides } from "../plugins/dream_commands/defaultOverrides.js";
import { botCustomisationDefaultOverrides } from "../plugins/bot_customisation/defaultOverrides.js";
import { reviewsDefaultOverrides } from "../plugins/reviews/defaultOverrides.js";
import { suggestionsDefaultOverrides } from "../plugins/suggestions/defaultOverrides.js";
import { scamProtectDefaultOverrides } from "../plugins/scam_protect/defaultOverrides.js";
import { passportDefaultOverrides } from "../plugins/passport/defaultOverrides.js";
import { economyDefaultOverrides } from "../plugins/economy/defaultOverrides.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import { zStarboardBoard, zStarboardConfig, type StarboardBoard, type StarboardConfig } from "../config/schemas/starboard.js";
import type { GuildMember } from "discord.js";

export const pluginDefaultOverrides: Record<string, typeof utilityDefaultOverrides> = {
  utility: utilityDefaultOverrides,
  infractions: infractionDefaultOverrides,
  automod: automodDefaultOverrides,
  scam_protect: scamProtectDefaultOverrides,
  passport: passportDefaultOverrides,
  economy: economyDefaultOverrides,
  admin: adminDefaultOverrides,
  slowmode: slowmodeDefaultOverrides,
  name_history: nameHistoryDefaultOverrides,
  locate_user: locateUserDefaultOverrides,
  stats: statsDefaultOverrides,
  custom_events: customEventsDefaultOverrides,
  command_aliases: commandAliasesDefaultOverrides,
  roles: rolesDefaultOverrides,
  reaction_roles: reactionRolesDefaultOverrides,
  role_buttons: roleButtonsDefaultOverrides,
  self_grantable_roles: selfGrantableRolesDefaultOverrides,
  pingable_roles: pingableRolesDefaultOverrides,
  role_manager: roleManagerDefaultOverrides,
  welcome_message: welcomeMessageDefaultOverrides,
  tags: tagsDefaultOverrides,
  post: postDefaultOverrides,
  autodelete: autodeleteDefaultOverrides,
  autoreactions: autoreactionsDefaultOverrides,
  autoreplies: autorepliesDefaultOverrides,
  autorole: autoroleDefaultOverrides,
  translation: translationDefaultOverrides,
  reminders: remindersDefaultOverrides,
  counters: countersDefaultOverrides,
  companion_channels: [],
  member_identity: [],
  dream_commands: dreamCommandsDefaultOverrides,
  bot_customisation: botCustomisationDefaultOverrides,
  reviews: reviewsDefaultOverrides,
  suggestions: suggestionsDefaultOverrides,
};

export const pluginsRequiringConfig = new Set(["utility", "infractions"]);

export function getPluginDefaultOverrides(pluginName: string) {
  return pluginDefaultOverrides[pluginName] ?? [];
}

export function getUtilityPluginConfig(
  guildConfig: GuildConfig,
  member?: GuildMember,
  channelId?: string,
  categoryId?: string | null,
) {
  return resolvePluginConfig(guildConfig, "utility", utilityDefaultOverrides, member, channelId, categoryId);
}

export function getInfractionPluginConfig(
  guildConfig: GuildConfig,
  member?: GuildMember,
  channelId?: string,
  categoryId?: string | null,
) {
  return resolvePluginConfig(guildConfig, "infractions", infractionDefaultOverrides, member, channelId, categoryId);
}

export function getAutorolePluginConfig(guildConfig: GuildConfig) {
  return resolvePluginConfig(guildConfig, "autorole", autoroleDefaultOverrides);
}

export function getTranslationPluginConfig(guildConfig: GuildConfig): TranslationConfig {
  const resolved = resolvePluginConfig(guildConfig, "translation", translationDefaultOverrides);
  return parsePluginConfig(zTranslationConfig, resolved);
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

export function canUseUtility(
  guildConfig: GuildConfig,
  permission: string,
  member: GuildMember,
  channelId: string,
  categoryId?: string | null,
): boolean {
  return hasPluginPermission(guildConfig, "utility", permission, member, channelId, categoryId, utilityDefaultOverrides);
}

export function canUseInfractions(
  guildConfig: GuildConfig,
  permission: string,
  member: GuildMember,
  channelId: string,
  categoryId?: string | null,
): boolean {
  return hasPluginPermission(
    guildConfig,
    "infractions",
    permission,
    member,
    channelId,
    categoryId,
    infractionDefaultOverrides,
  );
}

export async function ensureGuildConfigured(guildId: string): Promise<boolean> {
  const stored = await configManager.getGuildConfig(guildId);
  return stored !== null;
}
