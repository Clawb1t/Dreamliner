import { z } from "zod";

const pluginOverrideSchema = z.strictObject({
  level: z.string().optional(),
  channel: z.string().optional(),
  category: z.string().optional(),
  user: z.string().optional(),
  config: z.record(z.unknown()),
});

export const zUtilityConfig = z.strictObject({
  jumbo_size: z.number().int().min(16).max(2048).default(128),
  autojoin_threads: z.boolean().default(true),
  info_on_single_result: z.boolean().default(true),
  can_search: z.boolean().default(false),
  can_clean: z.boolean().default(false),
  can_userinfo: z.boolean().default(false),
  can_server: z.boolean().default(false),
  can_channelinfo: z.boolean().default(false),
  can_messageinfo: z.boolean().default(false),
  can_inviteinfo: z.boolean().default(false),
  can_roleinfo: z.boolean().default(false),
  can_emojiinfo: z.boolean().default(false),
  can_snowflake: z.boolean().default(false),
  can_roles: z.boolean().default(false),
  can_level: z.boolean().default(false),
  can_context: z.boolean().default(false),
  can_source: z.boolean().default(false),
  can_nickname: z.boolean().default(false),
  can_vcmove: z.boolean().default(false),
  can_vckick: z.boolean().default(false),
  can_ping: z.boolean().default(false),
  can_about: z.boolean().default(false),
  can_help: z.boolean().default(false),
  can_reload_guild: z.boolean().default(false),
  can_avatar: z.boolean().default(false),
  can_jumbo: z.boolean().default(false),
  can_info: z.boolean().default(false),
  can_time: z.boolean().default(false),
});

export type UtilityConfig = z.infer<typeof zUtilityConfig>;

export const zUtilityPluginSection = z.strictObject({
  enabled: z.boolean().optional(),
  config: zUtilityConfig.partial().optional(),
  overrides: z.array(pluginOverrideSchema).optional(),
  replaceDefaultOverrides: z.boolean().optional(),
});

export type UtilityPluginSection = z.infer<typeof zUtilityPluginSection>;
