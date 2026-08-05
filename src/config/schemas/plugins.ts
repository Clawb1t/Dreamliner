import { z } from "zod";
import { zPluginSection } from "./pluginSection.js";

const boolPerm = () => z.boolean().default(false);

export const zAutomodConfig = z.strictObject({
  enabled_rules: z.array(z.string()).default(["duplicate", "rate_limit"]),
  duplicate_window_ms: z.number().int().min(1000).default(30_000),
  duplicate_max: z.number().int().min(2).default(3),
  rate_limit_count: z.number().int().min(2).default(5),
  rate_limit_window_ms: z.number().int().min(1000).default(10_000),
  raid_join_count: z.number().int().min(2).default(10),
  raid_join_window_ms: z.number().int().min(1000).default(30_000),
  ignored_channels: z.array(z.string()).default([]),
  ignored_roles: z.array(z.string()).default([]),
  action: z.enum(["delete", "warn", "mute"]).default("delete"),
  mute_duration_ms: z.number().int().min(0).default(600_000),
  log_channel_id: z.string().optional(),
  can_status: boolPerm(),
  can_test: boolPerm(),
  can_configure: boolPerm(),
});

export const zCensorConfig = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        pattern: z.string(),
        regex: z.boolean().default(false),
        action: z.enum(["delete", "warn"]).default("delete"),
      }),
    )
    .default([]),
  ignored_channels: z.array(z.string()).default([]),
  can_list: boolPerm(),
  can_add: boolPerm(),
  can_remove: boolPerm(),
});

export const zAdminConfig = z.strictObject({
  lockdown_role_id: z.string().optional(),
  can_lockdown: boolPerm(),
  can_unlock: boolPerm(),
});

export const zPersistConfig = z.strictObject({
  can_add: boolPerm(),
  can_remove: boolPerm(),
  can_list: boolPerm(),
});

export const zSlowmodeRuleTarget = z.enum(["user", "role"]);

export const zSlowmodeRule = z.strictObject({
  id: z.number().int().positive().optional(),
  target: zSlowmodeRuleTarget,
  target_id: z.string().min(1),
  seconds: z.number().int().min(1).max(21600),
  /** Channel IDs this rule applies to. `"*"` or omit/empty means all channels. */
  channels: z.array(z.string()).default(["*"]),
});

export const zSlowmodeConfig = z.strictObject({
  default_seconds: z.number().int().min(0).max(21600).default(5),
  individual_enabled: z.boolean().default(true),
  allow_manage_messages_bypass: z.boolean().default(true),
  /** Applied when no user/role rule matches. `0` means no individual limit. */
  individual_default_seconds: z.number().int().min(0).max(21600).default(0),
  /** @deprecated Unused; kept so older configs still validate. */
  notice_delete_after_ms: z.number().int().min(1000).max(21_600_000).optional(),
  rules: z.array(zSlowmodeRule).default([]),
  can_set: boolPerm(),
  can_clear: boolPerm(),
  can_manage_rules: boolPerm(),
  can_configure: boolPerm(),
});

export const zRolesConfig = z.strictObject({
  can_give: boolPerm(),
  can_remove: boolPerm(),
  can_list: boolPerm(),
});

export const zReactionRolesConfig = z.strictObject({
  can_create: boolPerm(),
  can_delete: boolPerm(),
});

export const zRoleButtonsConfig = z.strictObject({
  can_create: boolPerm(),
  can_delete: boolPerm(),
});

export const zSelfGrantableRolesConfig = z.strictObject({
  can_configure: boolPerm(),
  max_roles_per_panel: z.number().int().min(1).max(25).default(10),
});

export const zPingableRolesConfig = z.strictObject({
  can_enable: boolPerm(),
  can_disable: boolPerm(),
});

export const zRoleManagerConfig = z.strictObject({
  can_create: boolPerm(),
  can_delete: boolPerm(),
  can_list: boolPerm(),
});

export const zWelcomeMessageConfig = z.strictObject({
  channel_id: z.string().optional(),
  message: z.string().default("Welcome {user} to **{guild}**!"),
  can_set: boolPerm(),
  can_test: boolPerm(),
  can_disable: boolPerm(),
});

export const zTagsConfig = z.strictObject({
  can_create: boolPerm(),
  can_edit: boolPerm(),
  can_delete: boolPerm(),
  can_list: boolPerm(),
  can_show: boolPerm(),
});

export const zPostConfig = z.strictObject({
  can_create: boolPerm(),
  can_list: boolPerm(),
  can_delete: boolPerm(),
});

export const zAutodeleteConfig = z.strictObject({
  can_set: boolPerm(),
  can_clear: boolPerm(),
  default_delay_seconds: z.number().int().min(1).default(60),
});

export const zAutoreactionTrigger = z.enum(["every_message", "contains", "starts_with", "exact", "regex"]);

export const zAutoreactionsConfig = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        id: z.number().int().positive().optional(),
        channel_id: z.string(),
        emoji: z.string(),
        /** Content match mode. Legacy rules with only `regex` are treated as regex. */
        trigger: zAutoreactionTrigger.optional(),
        /** Text used by contains / starts_with / exact / regex triggers. */
        match: z.string().optional(),
        /** @deprecated Prefer trigger=regex + match */
        regex: z.string().optional(),
        /** React on every Nth matching message (per channel). */
        every_n: z.number().int().min(2).max(1000).optional(),
        /** Minimum seconds between reactions for this rule in a channel. */
        cooldown_seconds: z.number().int().min(0).max(86_400).optional(),
        attachments_only: z.boolean().optional(),
        links_only: z.boolean().optional(),
      }),
    )
    .default([]),
  can_add: boolPerm(),
  can_remove: boolPerm(),
  can_list: boolPerm(),
});

/** Same match modes as autoreactions. */
export const zAutoreplyTrigger = zAutoreactionTrigger;

export const zAutorepliesConfig = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        id: z.number().int().positive().optional(),
        channel_id: z.string(),
        response: z.string().min(1).max(2000),
        trigger: zAutoreplyTrigger.optional(),
        match: z.string().optional(),
        every_n: z.number().int().min(2).max(1000).optional(),
        cooldown_seconds: z.number().int().min(0).max(86_400).optional(),
        attachments_only: z.boolean().optional(),
        links_only: z.boolean().optional(),
        /** When true (default), reply to the triggering message. */
        reply_to_message: z.boolean().optional(),
      }),
    )
    .default([]),
  can_add: boolPerm(),
  can_remove: boolPerm(),
  can_list: boolPerm(),
});

export const zRemindersConfig = z.strictObject({
  can_create: boolPerm(),
  can_list: boolPerm(),
  can_cancel: boolPerm(),
});

export const zCountersConfig = z.strictObject({
  can_create: boolPerm(),
  can_set: boolPerm(),
  can_delete: boolPerm(),
});

export const zCompanionChannelsConfig = z.strictObject({
  can_create: boolPerm(),
  can_delete: boolPerm(),
  name_template: z.string().default("{user}'s channel"),
});

export const zNameHistoryConfig = z.strictObject({
  can_view: boolPerm(),
  can_search: boolPerm(),
});

export const zUsernameSaverConfig = z.strictObject({
  enabled: z.boolean().default(true),
});

export const zLocateUserConfig = z.strictObject({
  can_locate: boolPerm(),
});

export const zStatsConfig = z.strictObject({
  can_server: boolPerm(),
  can_user: boolPerm(),
  can_channel: boolPerm(),
});

export const zCustomEventsConfig = z.strictObject({
  can_create: boolPerm(),
  can_delete: boolPerm(),
  can_list: boolPerm(),
});

export const zCommandAliasesConfig = z.strictObject({
  message_triggers: z.boolean().default(true),
  can_create: boolPerm(),
  can_delete: boolPerm(),
  can_list: boolPerm(),
  can_run: boolPerm(),
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
