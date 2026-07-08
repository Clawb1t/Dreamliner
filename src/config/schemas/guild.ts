import { z } from "zod";
import { zUtilityPluginSection } from "./utility.js";
import { zInfractionPluginSection } from "./infraction.js";
import { zAutorolePluginSection } from "./autorole.js";
import { zStarboardPluginSection } from "./starboard.js";
import {
  zAdminPluginSection,
  zAutomodPluginSection,
  zAutodeletePluginSection,
  zAutoreactionsPluginSection,
  zCensorPluginSection,
  zCommandAliasesPluginSection,
  zCompanionChannelsPluginSection,
  zCountersPluginSection,
  zCustomEventsPluginSection,
  zLocateUserPluginSection,
  zNameHistoryPluginSection,
  zPersistPluginSection,
  zPingableRolesPluginSection,
  zPostPluginSection,
  zReactionRolesPluginSection,
  zRemindersPluginSection,
  zRoleButtonsPluginSection,
  zRoleManagerPluginSection,
  zRolesPluginSection,
  zSelfGrantableRolesPluginSection,
  zSlowmodePluginSection,
  zStatsPluginSection,
  zTagsPluginSection,
  zUsernameSaverPluginSection,
  zWelcomeMessagePluginSection,
} from "./plugins.js";

export const zEmojisConfig = z.strictObject({
  success: z.string().default("<:checked:1524379445379465276>"),
  error: z.string().default("<:redcheck:1524379423757959208>"),
  neutral: z.string().default("<:greycheck:1524379394372669553>"),
  warning: z.string().default("<:lowwarning:1524379341000151170>"),
  unchecked: z.string().default("<:unchecked:1524379366996312104>"),
});

export const zGuildConfig = z.strictObject({
  emojis: zEmojisConfig.default({}),
  levels: z.record(z.coerce.number()).default({}),
  /** @deprecated Use moderation_log_channel_id */
  log_channel_id: z.string().optional(),
  server_log_channel_id: z.string().optional(),
  moderation_log_channel_id: z.string().optional(),
  ephemeral_responses: z.boolean().default(false),
  plugins: z
    .strictObject({
      utility: zUtilityPluginSection.optional(),
      infractions: zInfractionPluginSection.optional(),
      autorole: zAutorolePluginSection.optional(),
      starboard: zStarboardPluginSection.optional(),
      automod: zAutomodPluginSection.optional(),
      censor: zCensorPluginSection.optional(),
      admin: zAdminPluginSection.optional(),
      persist: zPersistPluginSection.optional(),
      slowmode: zSlowmodePluginSection.optional(),
      roles: zRolesPluginSection.optional(),
      reaction_roles: zReactionRolesPluginSection.optional(),
      role_buttons: zRoleButtonsPluginSection.optional(),
      self_grantable_roles: zSelfGrantableRolesPluginSection.optional(),
      pingable_roles: zPingableRolesPluginSection.optional(),
      role_manager: zRoleManagerPluginSection.optional(),
      welcome_message: zWelcomeMessagePluginSection.optional(),
      tags: zTagsPluginSection.optional(),
      post: zPostPluginSection.optional(),
      autodelete: zAutodeletePluginSection.optional(),
      autoreactions: zAutoreactionsPluginSection.optional(),
      reminders: zRemindersPluginSection.optional(),
      counters: zCountersPluginSection.optional(),
      companion_channels: zCompanionChannelsPluginSection.optional(),
      name_history: zNameHistoryPluginSection.optional(),
      username_saver: zUsernameSaverPluginSection.optional(),
      locate_user: zLocateUserPluginSection.optional(),
      stats: zStatsPluginSection.optional(),
      custom_events: zCustomEventsPluginSection.optional(),
      command_aliases: zCommandAliasesPluginSection.optional(),
    })
    .default({}),
});

export type GuildConfig = z.infer<typeof zGuildConfig>;
export type EmojisConfig = z.infer<typeof zEmojisConfig>;

export type PluginOverride = {
  level?: string;
  channel?: string;
  category?: string;
  user?: string;
  config: Record<string, unknown>;
};
