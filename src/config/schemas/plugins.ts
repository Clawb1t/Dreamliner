import { z } from "zod";
import { boolPerm, channelId, roleId } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

export const zAutomodConfig = z.strictObject({
  enabled_rules: z
    .array(z.string())
    .default(["duplicate", "rate_limit"])
    .describe('Which automod rules are active. Common values: "duplicate", "rate_limit", "raid".'),
  duplicate_window_ms: z
    .number()
    .int()
    .min(1000)
    .default(30_000)
    .describe("How long (ms) to watch for repeated identical messages from the same user."),
  duplicate_max: z
    .number()
    .int()
    .min(2)
    .default(3)
    .describe("How many duplicate messages in the window trigger an action."),
  rate_limit_count: z
    .number()
    .int()
    .min(2)
    .default(5)
    .describe("How many messages in the rate-limit window trigger an action."),
  rate_limit_window_ms: z
    .number()
    .int()
    .min(1000)
    .default(10_000)
    .describe("Time window (ms) used for rate-limit counting."),
  raid_join_count: z
    .number()
    .int()
    .min(2)
    .default(10)
    .describe("How many joins in the raid window look like a raid."),
  raid_join_window_ms: z
    .number()
    .int()
    .min(1000)
    .default(30_000)
    .describe("Time window (ms) used for raid join detection."),
  ignored_channels: z
    .array(z.string())
    .default([])
    .describe("Channel IDs automod should skip."),
  ignored_roles: z
    .array(z.string())
    .default([])
    .describe("Role IDs that bypass automod (mods/admins usually)."),
  action: z
    .enum(["delete", "warn", "mute"])
    .default("delete")
    .describe("What to do when a rule trips."),
  mute_duration_ms: z
    .number()
    .int()
    .min(0)
    .default(600_000)
    .describe("Mute length (ms) when action is mute. 600000 = 10 minutes."),
  log_channel_id: channelId("Optional channel for automod hits. Falls back to moderation logs if empty."),
  can_status: boolPerm("check automod status"),
  can_test: boolPerm("run automod tests"),
  can_configure: boolPerm("configure automod settings in Discord"),
});

export const zCensorConfig = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        pattern: z.string().describe("Word/phrase to match, or a regex if Regex is enabled."),
        regex: z.boolean().default(false).describe("Treat Pattern as a regular expression."),
        action: z
          .enum(["delete", "warn"])
          .default("delete")
          .describe("What happens when the pattern matches."),
      }),
    )
    .default([])
    .describe("Filter rules. Add entries for words or phrases you want blocked."),
  ignored_channels: z
    .array(z.string())
    .default([])
    .describe("Channel IDs where censor rules do not apply."),
  can_list: boolPerm("list censor rules"),
  can_add: boolPerm("add censor rules"),
  can_remove: boolPerm("remove censor rules"),
});

export const zAdminConfig = z.strictObject({
  lockdown_role_id: roleId("Role applied during channel lockdown (optional)."),
  can_lockdown: boolPerm("lock down channels"),
  can_unlock: boolPerm("unlock channels"),
});

export const zPersistConfig = z.strictObject({
  can_add: boolPerm("add sticky/persist messages"),
  can_remove: boolPerm("remove sticky/persist messages"),
  can_list: boolPerm("list sticky/persist messages"),
});

export const zSlowmodeRuleTarget = z.enum(["user", "role"]);

export const zSlowmodeRule = z.strictObject({
  id: z.number().int().positive().optional().describe("Optional rule id (usually assigned by the bot)."),
  target: zSlowmodeRuleTarget.describe('Whether this rule applies to a "user" or a "role".'),
  target_id: z.string().min(1).describe("User or role snowflake ID this rule applies to."),
  seconds: z
    .number()
    .int()
    .min(1)
    .max(21600)
    .describe("Slowmode delay in seconds for this target (max 21600 = 6 hours)."),
  channels: z
    .array(z.string())
    .default(["*"])
    .describe('Channel IDs this rule applies to. Use "*" for all channels.'),
});

export const zSlowmodeConfig = z.strictObject({
  default_seconds: z
    .number()
    .int()
    .min(0)
    .max(21600)
    .default(5)
    .describe("Default channel slowmode in seconds when using slowmode commands."),
  individual_enabled: z
    .boolean()
    .default(true)
    .describe("Enable per-user / per-role slowmode rules."),
  allow_manage_messages_bypass: z
    .boolean()
    .default(true)
    .describe("Let members with Manage Messages bypass individual slowmode."),
  individual_default_seconds: z
    .number()
    .int()
    .min(0)
    .max(21600)
    .default(0)
    .describe("Fallback individual slowmode (seconds) when no user/role rule matches. 0 = none."),
  notice_delete_after_ms: z
    .number()
    .int()
    .min(1000)
    .max(21_600_000)
    .optional()
    .describe("Deprecated. Kept so older configs still validate."),
  rules: z.array(zSlowmodeRule).default([]).describe("Per-user or per-role slowmode rules."),
  can_set: boolPerm("set channel slowmode"),
  can_clear: boolPerm("clear slowmode"),
  can_manage_rules: boolPerm("manage individual slowmode rules"),
  can_configure: boolPerm("configure slowmode settings"),
});

export const zRolesConfig = z.strictObject({
  can_give: boolPerm("give roles with /role"),
  can_remove: boolPerm("remove roles with /role"),
  can_list: boolPerm("list roles"),
});

export const zReactionRolesConfig = z.strictObject({
  can_create: boolPerm("create reaction-role menus"),
  can_delete: boolPerm("delete reaction-role menus"),
});

export const zRoleButtonsConfig = z.strictObject({
  can_create: boolPerm("create button role panels"),
  can_delete: boolPerm("delete button role panels"),
});

export const zSelfGrantableRolesConfig = z.strictObject({
  can_configure: boolPerm("configure self-serve role panels"),
  max_roles_per_panel: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe("Maximum roles allowed on one self-grant panel."),
});

export const zPingableRolesConfig = z.strictObject({
  can_enable: boolPerm("temporarily make roles mentionable"),
  can_disable: boolPerm("disable temporary pingable roles"),
});

export const zRoleManagerConfig = z.strictObject({
  can_create: boolPerm("create roles from templates"),
  can_delete: boolPerm("delete role templates"),
  can_list: boolPerm("list role templates"),
});

export const zWelcomeMessageConfig = z.strictObject({
  channel_id: channelId("Channel where welcome messages are posted."),
  message: z
    .string()
    .default("Welcome {user} to **{guild}**!")
    .describe("Welcome text. Placeholders: {user}, {user_name}, {guild}, {member_count}."),
  can_set: boolPerm("set the welcome message"),
  can_test: boolPerm("test the welcome message"),
  can_disable: boolPerm("disable welcome messages"),
});

export const zTagsConfig = z.strictObject({
  can_create: boolPerm("create tags"),
  can_edit: boolPerm("edit tags"),
  can_delete: boolPerm("delete tags"),
  can_list: boolPerm("list tags"),
  can_show: boolPerm("show/use tags"),
});

export const zPostConfig = z.strictObject({
  can_create: boolPerm("create scheduled posts"),
  can_list: boolPerm("list scheduled posts"),
  can_delete: boolPerm("delete scheduled posts"),
});

export const zAutodeleteConfig = z.strictObject({
  can_set: boolPerm("set autodelete on a channel"),
  can_clear: boolPerm("clear autodelete"),
  default_delay_seconds: z
    .number()
    .int()
    .min(1)
    .default(60)
    .describe("Default delay before messages are deleted (seconds)."),
});

export const zAutoreactionTrigger = z.enum(["every_message", "contains", "starts_with", "exact", "regex"]);

export const zAutoreactionsConfig = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        id: z.number().int().positive().optional().describe("Optional rule id."),
        channel_id: z.string().describe("Channel ID where this rule listens."),
        emoji: z.string().describe("Emoji to react with (Unicode or <:name:id>)."),
        trigger: zAutoreactionTrigger
          .optional()
          .describe("When to match: every_message, contains, starts_with, exact, or regex."),
        match: z.string().optional().describe("Text used by contains / starts_with / exact / regex triggers."),
        regex: z.string().optional().describe("Deprecated. Prefer trigger=regex with match."),
        every_n: z
          .number()
          .int()
          .min(2)
          .max(1000)
          .optional()
          .describe("Only react on every Nth matching message in the channel."),
        cooldown_seconds: z
          .number()
          .int()
          .min(0)
          .max(86_400)
          .optional()
          .describe("Minimum seconds between reactions for this rule."),
        attachments_only: z.boolean().optional().describe("Only match messages that include attachments."),
        links_only: z.boolean().optional().describe("Only match messages that include links."),
      }),
    )
    .default([])
    .describe("Autoreaction rules. Each rule watches one channel and reacts when it matches."),
  can_add: boolPerm("add autoreaction rules"),
  can_remove: boolPerm("remove autoreaction rules"),
  can_list: boolPerm("list autoreaction rules"),
});

/** Same match modes as autoreactions. */
export const zAutoreplyTrigger = zAutoreactionTrigger;

export const zAutorepliesConfig = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        id: z.number().int().positive().optional().describe("Optional rule id."),
        channel_id: z.string().describe("Channel ID where this rule listens."),
        response: z
          .string()
          .min(1)
          .max(2000)
          .describe("Message Dreamliner sends when the rule matches."),
        trigger: zAutoreplyTrigger
          .optional()
          .describe("When to match: every_message, contains, starts_with, exact, or regex."),
        match: z.string().optional().describe("Text used by contains / starts_with / exact / regex triggers."),
        every_n: z
          .number()
          .int()
          .min(2)
          .max(1000)
          .optional()
          .describe("Only reply on every Nth matching message."),
        cooldown_seconds: z
          .number()
          .int()
          .min(0)
          .max(86_400)
          .optional()
          .describe("Minimum seconds between replies for this rule."),
        attachments_only: z.boolean().optional().describe("Only match messages that include attachments."),
        links_only: z.boolean().optional().describe("Only match messages that include links."),
        reply_to_message: z
          .boolean()
          .optional()
          .describe("When true (default), reply to the triggering message instead of sending a standalone message."),
      }),
    )
    .default([])
    .describe("Autoreply rules. Each rule watches one channel and replies when it matches."),
  can_add: boolPerm("add autoreply rules"),
  can_remove: boolPerm("remove autoreply rules"),
  can_list: boolPerm("list autoreply rules"),
});

export const zRemindersConfig = z.strictObject({
  can_create: boolPerm("create reminders"),
  can_list: boolPerm("list reminders"),
  can_cancel: boolPerm("cancel reminders"),
});

export const zCountersConfig = z.strictObject({
  can_create: boolPerm("create counters"),
  can_set: boolPerm("set counter values"),
  can_delete: boolPerm("delete counters"),
});

export const zCompanionChannelsConfig = z.strictObject({
  can_create: boolPerm("create companion voice hubs"),
  can_delete: boolPerm("delete companion setups"),
  name_template: z
    .string()
    .default("{user}'s channel")
    .describe("Name for temporary voice channels. Placeholder: {user}."),
});

export const zNameHistoryConfig = z.strictObject({
  can_view: boolPerm("view name history"),
  can_search: boolPerm("search name history"),
});

export const zUsernameSaverConfig = z.strictObject({
  enabled: z
    .boolean()
    .default(true)
    .describe("When true, Dreamliner stores username history for members."),
});

export const zLocateUserConfig = z.strictObject({
  can_locate: boolPerm("locate where a member currently is"),
});

export const zStatsConfig = z.strictObject({
  can_server: boolPerm("view server stats"),
  can_user: boolPerm("view user stats"),
  can_channel: boolPerm("view channel stats"),
});

export const zCustomEventsConfig = z.strictObject({
  can_create: boolPerm("create custom event hooks"),
  can_delete: boolPerm("delete custom event hooks"),
  can_list: boolPerm("list custom event hooks"),
});

export const zCommandAliasesConfig = z.strictObject({
  message_triggers: z
    .boolean()
    .default(true)
    .describe("Allow message-based alias triggers in addition to slash commands."),
  can_create: boolPerm("create command aliases"),
  can_delete: boolPerm("delete command aliases"),
  can_list: boolPerm("list command aliases"),
  can_run: boolPerm("run command aliases"),
});

export const zDreamCommandsConfig = z.strictObject({
  prefix: z
    .string()
    .min(1)
    .max(10)
    .default("d!")
    .describe('Message prefix for custom Dreamcode commands (e.g. "d!" → d!boom).'),
  can_create: boolPerm("create Dreamcode custom commands"),
  can_edit: boolPerm("download/upload Dreamcode command source"),
  can_remove: boolPerm("remove Dreamcode custom commands"),
  can_list: boolPerm("list Dreamcode custom commands"),
});

export const zBotCustomisationConfig = z.strictObject({
  can_avatar: boolPerm("set or clear Dreamliner's per-server avatar"),
  can_nickname: boolPerm("set or clear Dreamliner's server nickname"),
});

export const zAutomodPluginSection = zPluginSection(zAutomodConfig.shape);
export const zCensorPluginSection = zPluginSection(zCensorConfig.shape);
export const zAdminPluginSection = zPluginSection(zAdminConfig.shape);
export const zPersistPluginSection = zPluginSection(zPersistConfig.shape);
export const zSlowmodePluginSection = zPluginSection(zSlowmodeConfig.shape);
export const zRolesPluginSection = zPluginSection(zRolesConfig.shape);
export const zReactionRolesPluginSection = zPluginSection(zReactionRolesConfig.shape);
export const zRoleButtonsPluginSection = zPluginSection(zRoleButtonsConfig.shape);
export const zSelfGrantableRolesPluginSection = zPluginSection(zSelfGrantableRolesConfig.shape);
export const zPingableRolesPluginSection = zPluginSection(zPingableRolesConfig.shape);
export const zRoleManagerPluginSection = zPluginSection(zRoleManagerConfig.shape);
export const zWelcomeMessagePluginSection = zPluginSection(zWelcomeMessageConfig.shape);
export const zTagsPluginSection = zPluginSection(zTagsConfig.shape);
export const zPostPluginSection = zPluginSection(zPostConfig.shape);
export const zAutodeletePluginSection = zPluginSection(zAutodeleteConfig.shape);
export const zAutoreactionsPluginSection = zPluginSection(zAutoreactionsConfig.shape);
export const zAutorepliesPluginSection = zPluginSection(zAutorepliesConfig.shape);
export const zRemindersPluginSection = zPluginSection(zRemindersConfig.shape);
export const zCountersPluginSection = zPluginSection(zCountersConfig.shape);
export const zCompanionChannelsPluginSection = zPluginSection(zCompanionChannelsConfig.shape);
export const zNameHistoryPluginSection = zPluginSection(zNameHistoryConfig.shape);
export const zUsernameSaverPluginSection = zPluginSection(zUsernameSaverConfig.shape);
export const zLocateUserPluginSection = zPluginSection(zLocateUserConfig.shape);
export const zStatsPluginSection = zPluginSection(zStatsConfig.shape);
export const zCustomEventsPluginSection = zPluginSection(zCustomEventsConfig.shape);
export const zCommandAliasesPluginSection = zPluginSection(zCommandAliasesConfig.shape);
export const zDreamCommandsPluginSection = zPluginSection(zDreamCommandsConfig.shape);
export const zBotCustomisationPluginSection = zPluginSection(zBotCustomisationConfig.shape);

export type AutomodConfig = z.infer<typeof zAutomodConfig>;
export type CensorConfig = z.infer<typeof zCensorConfig>;
export type AdminConfig = z.infer<typeof zAdminConfig>;
export type PersistConfig = z.infer<typeof zPersistConfig>;
export type SlowmodeConfig = z.infer<typeof zSlowmodeConfig>;
export type SlowmodeRule = z.infer<typeof zSlowmodeRule>;
export type SlowmodeRuleTarget = z.infer<typeof zSlowmodeRuleTarget>;
export type TagsConfig = z.infer<typeof zTagsConfig>;
export type WelcomeMessageConfig = z.infer<typeof zWelcomeMessageConfig>;
export type RolesConfig = z.infer<typeof zRolesConfig>;
export type ReactionRolesConfig = z.infer<typeof zReactionRolesConfig>;
export type RoleButtonsConfig = z.infer<typeof zRoleButtonsConfig>;
export type SelfGrantableRolesConfig = z.infer<typeof zSelfGrantableRolesConfig>;
export type PingableRolesConfig = z.infer<typeof zPingableRolesConfig>;
export type RoleManagerConfig = z.infer<typeof zRoleManagerConfig>;
export type DreamCommandsConfig = z.infer<typeof zDreamCommandsConfig>;
export type BotCustomisationConfig = z.infer<typeof zBotCustomisationConfig>;
export type CommandAliasesConfig = z.infer<typeof zCommandAliasesConfig>;
