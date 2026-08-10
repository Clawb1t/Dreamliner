import type { ZodType } from "zod";
import { zInfractionConfig } from "../config/schemas/infraction.js";
import { zAutoroleConfig } from "../config/schemas/autorole.js";
import { zTranslationConfig } from "../config/schemas/translation.js";
import { zStarboardConfig } from "../config/schemas/starboard.js";
import { zReviewsConfig } from "../config/schemas/reviews.js";
import { zSuggestionsConfig } from "../config/schemas/suggestions.js";
import { zScamProtectConfig } from "../config/schemas/scamProtect.js";
import { zUtilityConfig } from "../config/schemas/utility.js";
import {
  zAdminConfig,
  zAutomodConfig,
  zCommandAliasesConfig,
  zCustomEventsConfig,
  zDreamCommandsConfig,
  zLocateUserConfig,
  zNameHistoryConfig,
  zPersistConfig,
  zPingableRolesConfig,
  zReactionRolesConfig,
  zRoleButtonsConfig,
  zRoleManagerConfig,
  zRolesConfig,
  zSelfGrantableRolesConfig,
  zSlowmodeConfig,
  zStatsConfig,
  zUsernameSaverConfig,
  zAutodeleteConfig,
  zAutoreactionsConfig,
  zAutorepliesConfig,
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
  translation: zTranslationConfig,
  starboard: zStarboardConfig,
  automod: zAutomodConfig,
  scam_protect: zScamProtectConfig,
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
  self_grantable_roles: zSelfGrantableRolesConfig,
  pingable_roles: zPingableRolesConfig,
  role_manager: zRoleManagerConfig,
  welcome_message: zWelcomeMessageConfig,
  tags: zTagsConfig,
  post: zPostConfig,
  autodelete: zAutodeleteConfig,
  autoreactions: zAutoreactionsConfig,
  autoreplies: zAutorepliesConfig,
  reminders: zRemindersConfig,
  counters: zCountersConfig,
  companion_channels: zCompanionChannelsConfig,
  bot_customisation: zBotCustomisationConfig,
  reviews: zReviewsConfig,
  suggestions: zSuggestionsConfig,
};

export function getPluginBaseConfig(pluginName: string): Record<string, unknown> {
  const schema = pluginConfigSchemas[pluginName];
  if (!schema) return {};
  return schema.parse({}) as Record<string, unknown>;
}
