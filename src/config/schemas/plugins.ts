import { z } from "zod";
import { boolPerm, roleId } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";
import { zAutomodConfig } from "./automod.js";
import { zWelcomeMessageConfig } from "./welcome.js";

export {
  AUTOMOD_ACTION_TYPES,
  AUTOMOD_PRESETS,
  AUTOMOD_RULE_IDS,
  AUTOMOD_SENSITIVITIES,
  zAutomodConfig,
  zAutomodFilterEntry,
  zAutomodLadderAction,
  zAutomodLadderStep,
  zAutomodRuleConfig,
  type AutomodActionType,
  type AutomodConfig,
  type AutomodFilterEntry,
  type AutomodLadderAction,
  type AutomodLadderStep,
  type AutomodPresetName,
  type AutomodRuleConfig,
  type AutomodRuleId,
  type AutomodSensitivity,
} from "./automod.js";

export {
  migrateWelcomeMessageInConfig,
  zWelcomeCardConfig,
  zWelcomeDmConfig,
  zWelcomeEmbedConfig,
  zWelcomeEmbedField,
  zWelcomeEventConfig,
  zWelcomeMessageConfig,
  type WelcomeCardConfig,
  type WelcomeDmConfig,
  type WelcomeEmbedConfig,
  type WelcomeEmbedField,
  type WelcomeEventConfig,
  type WelcomeMessageConfig,
} from "./welcome.js";

export {
  zPersistButton,
  zPersistConfig,
  zPersistEmbedConfig,
  zPersistEmbedField,
  zPersistSticky,
  type PersistButton,
  type PersistConfig,
  type PersistEmbedConfig,
  type PersistEmbedField,
  type PersistSticky,
} from "./persist.js";

import { zPersistButton, zPersistConfig, zPersistEmbedConfig } from "./persist.js";

export const zAdminConfig = z.strictObject({
  lockdown_role_id: roleId("Role applied during channel lockdown (optional)."),
  can_lockdown: boolPerm("lock down channels"),
  can_unlock: boolPerm("unlock channels"),
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
        channel_id: z
          .string()
          .optional()
          .describe("Channel ID where this rule listens. Leave empty or use * for all channels."),
        emoji: z.string().describe("Emoji to react with (Unicode or <:name:id>)."),
        trigger: zAutoreactionTrigger
          .optional()
          .describe("When to match: every_message, contains, starts_with, exact, or regex."),
        match: z
          .string()
          .optional()
          .describe(
            "Text used by contains / starts_with / exact / regex. Regex is case-insensitive. Whole word: \\bthread\\b.",
          ),
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
    .describe("Autoreaction rules. Each rule listens in one channel (or all channels) and reacts when it matches."),
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
        channel_id: z
          .string()
          .optional()
          .describe("Channel ID where this rule listens. Leave empty or use * for all channels."),
        response: z
          .string()
          .max(2000)
          .default("")
          .describe(
            "Optional text above the embed. Supports placeholders like {user}, {guild}, {channel}. Can be empty if an embed or buttons are set.",
          ),
        trigger: zAutoreplyTrigger
          .optional()
          .describe("When to match: every_message, contains, starts_with, exact, or regex."),
        match: z
          .string()
          .optional()
          .describe(
            "Text used by contains / starts_with / exact / regex. Regex is case-insensitive. Whole word: \\bthread\\b.",
          ),
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
          .describe("When true (default), reply to the triggering message instead of sending a standalone message. Ignored when sending as a webhook."),
        embed: zPersistEmbedConfig.default({}).describe("Optional Discord embed."),
        buttons: z
          .array(zPersistButton)
          .max(5)
          .default([])
          .describe("Optional link buttons under the reply (max 5)."),
        webhook: z
          .boolean()
          .optional()
          .describe(
            "Send as a webhook with a custom name and avatar. Requires Manage Webhooks. Falls back to the bot if a webhook cannot be created.",
          ),
        webhook_name: z
          .string()
          .max(80)
          .optional()
          .describe("Webhook display name. Defaults to Autoreply."),
        webhook_avatar_url: z
          .string()
          .max(512)
          .optional()
          .describe("Webhook avatar image URL (https)."),
        silent: z.boolean().optional().describe("Send without notifying members (suppress notifications)."),
        suppress_embeds: z
          .boolean()
          .optional()
          .describe("Do not unfurl links in the text content into extra embeds."),
        mention_users: z.boolean().optional().describe("Allow @user mentions in the reply text."),
        mention_roles: z.boolean().optional().describe("Allow @role mentions in the reply text."),
        mention_everyone: z.boolean().optional().describe("Allow @everyone / @here in the reply text."),
      }),
    )
    .default([])
    .describe("Autoreply rules. Each rule listens in one channel (or all channels) and replies when it matches."),
  can_add: boolPerm("add autoreply rules"),
  can_remove: boolPerm("remove autoreply rules"),
  can_list: boolPerm("list autoreply rules"),
});

const zThreadArchiveMinutes = z
  .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
  .default(1440)
  .describe("How long the thread stays idle before auto-archiving: 60, 1440, 4320, or 10080 minutes.");

/** Same match modes and rich message payload as autoreplies; starts a thread on the matching message. */
export const zAutothreadTrigger = zAutoreactionTrigger;

export const zAutothreadsConfig = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        id: z.number().int().positive().optional().describe("Optional rule id."),
        channel_id: z
          .string()
          .optional()
          .describe("Channel ID where this rule listens. Leave empty or use * for all channels."),
        thread_name: z
          .string()
          .max(100)
          .default("{user_display}")
          .describe("Thread title. Supports placeholders like {user_display}, {guild}, {channel}."),
        auto_archive_minutes: zThreadArchiveMinutes,
        thread_slowmode_seconds: z
          .number()
          .int()
          .min(0)
          .max(21_600)
          .optional()
          .describe("Optional slowmode inside the new thread (seconds). 0 or omit for none."),
        response: z
          .string()
          .max(2000)
          .default("")
          .describe(
            "Optional text posted in the new thread. Supports placeholders. Can be empty if an embed or buttons are set.",
          ),
        trigger: zAutothreadTrigger
          .optional()
          .describe("When to match: every_message, contains, starts_with, exact, or regex."),
        match: z
          .string()
          .optional()
          .describe(
            "Text used by contains / starts_with / exact / regex. Regex is case-insensitive. Whole word: \\bthread\\b.",
          ),
        every_n: z
          .number()
          .int()
          .min(2)
          .max(1000)
          .optional()
          .describe("Only create a thread on every Nth matching message."),
        cooldown_seconds: z
          .number()
          .int()
          .min(0)
          .max(86_400)
          .optional()
          .describe("Minimum seconds between threads for this rule."),
        attachments_only: z.boolean().optional().describe("Only match messages that include attachments."),
        links_only: z.boolean().optional().describe("Only match messages that include links."),
        embed: zPersistEmbedConfig.default({}).describe("Optional Discord embed posted in the thread."),
        buttons: z
          .array(zPersistButton)
          .max(5)
          .default([])
          .describe("Optional link buttons under the thread message (max 5)."),
        webhook: z
          .boolean()
          .optional()
          .describe(
            "Send the thread message as a webhook with a custom name and avatar. Requires Manage Webhooks.",
          ),
        webhook_name: z
          .string()
          .max(80)
          .optional()
          .describe("Webhook display name. Defaults to Autothread."),
        webhook_avatar_url: z
          .string()
          .max(512)
          .optional()
          .describe("Webhook avatar image URL (https)."),
        silent: z.boolean().optional().describe("Send without notifying members (suppress notifications)."),
        suppress_embeds: z
          .boolean()
          .optional()
          .describe("Do not unfurl links in the text content into extra embeds."),
        mention_users: z.boolean().optional().describe("Allow @user mentions in the thread message."),
        mention_roles: z.boolean().optional().describe("Allow @role mentions in the thread message."),
        mention_everyone: z.boolean().optional().describe("Allow @everyone / @here in the thread message."),
      }),
    )
    .default([])
    .describe(
      "Autothread rules. Each rule listens in one channel (or all channels) and starts a thread when it matches.",
    ),
  can_add: boolPerm("add autothread rules"),
  can_remove: boolPerm("remove autothread rules"),
  can_list: boolPerm("list autothread rules"),
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

export {
  COMPANION_FEATURE_KEYS,
  COMPANION_PERMISSION_SOURCES,
  COMPANION_SETUP_TYPES,
  migrateCompanionChannelsInConfig,
  zCompanionChannelsConfig,
  zCompanionFeatures,
  zCompanionSetup,
  type CompanionChannelsConfig,
  type CompanionFeatureKey,
  type CompanionFeatures,
  type CompanionPermissionSource,
  type CompanionSetup,
  type CompanionSetupType,
} from "./companion.js";

import { zCompanionChannelsConfig } from "./companion.js";

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

export const zMemberIdentityConfig = z.strictObject({
  save_on_leave: z
    .boolean()
    .default(true)
    .describe("Save a member's nickname, roles, and timeout when they leave the server."),
  save_on_update: z
    .boolean()
    .default(true)
    .describe(
      "Keep the snapshot current whenever nickname, roles, or timeout change. Recommended so leave events with incomplete member data still restore correctly.",
    ),
  restore_nickname: z
    .boolean()
    .default(true)
    .describe("Reapply the saved server nickname when the member rejoins."),
  restore_roles: z
    .boolean()
    .default(true)
    .describe(
      "Reapply saved roles when the member rejoins. Roles are added on top of autorole and other join roles; existing roles are not stripped.",
    ),
  restore_timeout: z
    .boolean()
    .default(false)
    .describe(
      "Reapply a remaining timeout (communication disabled until) if it had not expired when they left. Requires Moderate Members. Off by default.",
    ),
  skip_managed_roles: z
    .boolean()
    .default(true)
    .describe("Do not restore integration, bot, or boost roles that Discord manages."),
  ignore_bots: z
    .boolean()
    .default(true)
    .describe("Skip saving and restoring identity for bot accounts."),
  ignored_roles: z
    .array(z.string())
    .default([])
    .describe("Role IDs that are never restored, even if they were saved."),
  delay_ms: z
    .number()
    .int()
    .min(0)
    .max(300000)
    .default(0)
    .describe(
      "Wait this many milliseconds after join before restoring. Use a short delay if another join plugin should run first. 0 = restore immediately.",
    ),
});

export const zLocateUserConfig = z.strictObject({
  can_locate: boolPerm("locate where a member currently is"),
  can_seen: boolPerm("see when a member was last active"),
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
  /** @deprecated Ignored. Dreamcode commands are slash-only. Kept so older YAML still parses. */
  prefix: z
    .string()
    .min(1)
    .max(10)
    .optional()
    .describe("Deprecated and ignored. Dreamcode custom commands are slash-only."),
  can_create: boolPerm("create Dreamcode custom commands"),
  can_edit: boolPerm("download/upload Dreamcode command source"),
  can_remove: boolPerm("remove Dreamcode custom commands"),
  can_list: boolPerm("list Dreamcode custom commands"),
});

export const zBotCustomisationConfig = z.strictObject({
  can_avatar: boolPerm("submit or clear Dreamliner's per-server avatar (dashboard)"),
  can_banner: boolPerm("submit or clear Dreamliner's per-server banner (dashboard)"),
  can_nickname: boolPerm("set or clear Dreamliner's server nickname (dashboard)"),
  can_bio: boolPerm("set or clear Dreamliner's server bio (dashboard)"),
  can_display_name: boolPerm("set or clear Dreamliner's display name font, effect, and colors (dashboard)"),
});

export const zAutomodPluginSection = zPluginSection(zAutomodConfig.shape);
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
export const zAutothreadsPluginSection = zPluginSection(zAutothreadsConfig.shape);
export const zRemindersPluginSection = zPluginSection(zRemindersConfig.shape);
export const zCountersPluginSection = zPluginSection(zCountersConfig.shape);
export const zCompanionChannelsPluginSection = zPluginSection(zCompanionChannelsConfig.shape);
export const zNameHistoryPluginSection = zPluginSection(zNameHistoryConfig.shape);
export const zUsernameSaverPluginSection = zPluginSection(zUsernameSaverConfig.shape);
export const zMemberIdentityPluginSection = zPluginSection(zMemberIdentityConfig.shape);
export const zLocateUserPluginSection = zPluginSection(zLocateUserConfig.shape);
export const zStatsPluginSection = zPluginSection(zStatsConfig.shape);
export const zCustomEventsPluginSection = zPluginSection(zCustomEventsConfig.shape);
export const zCommandAliasesPluginSection = zPluginSection(zCommandAliasesConfig.shape);
export const zDreamCommandsPluginSection = zPluginSection(zDreamCommandsConfig.shape);
export const zBotCustomisationPluginSection = zPluginSection(zBotCustomisationConfig.shape);

export type AdminConfig = z.infer<typeof zAdminConfig>;
export type SlowmodeConfig = z.infer<typeof zSlowmodeConfig>;
export type SlowmodeRule = z.infer<typeof zSlowmodeRule>;
export type SlowmodeRuleTarget = z.infer<typeof zSlowmodeRuleTarget>;
export type TagsConfig = z.infer<typeof zTagsConfig>;
export type RolesConfig = z.infer<typeof zRolesConfig>;
export type ReactionRolesConfig = z.infer<typeof zReactionRolesConfig>;
export type RoleButtonsConfig = z.infer<typeof zRoleButtonsConfig>;
export type SelfGrantableRolesConfig = z.infer<typeof zSelfGrantableRolesConfig>;
export type PingableRolesConfig = z.infer<typeof zPingableRolesConfig>;
export type RoleManagerConfig = z.infer<typeof zRoleManagerConfig>;
export type DreamCommandsConfig = z.infer<typeof zDreamCommandsConfig>;
export type BotCustomisationConfig = z.infer<typeof zBotCustomisationConfig>;
export type CommandAliasesConfig = z.infer<typeof zCommandAliasesConfig>;
export type MemberIdentityConfig = z.infer<typeof zMemberIdentityConfig>;
