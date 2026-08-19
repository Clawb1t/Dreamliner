import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginOverride } from "./pluginSection.js";

export const zUtilityConfig = z.strictObject({
  jumbo_size: z
    .number()
    .int()
    .min(16)
    .max(2048)
    .default(128)
    .describe("Pixel size used by /jumbo when enlarging emoji."),
  autojoin_threads: z
    .boolean()
    .default(true)
    .describe("Automatically join threads when Dreamliner is mentioned or used in them."),
  expand_message_links: z
    .boolean()
    .default(true)
    .describe(
      "When a Discord message link is pasted in chat, repost that message (content and attachments) via webhook with the original author's name and avatar.",
    ),
  info_on_single_result: z
    .boolean()
    .default(true)
    .describe("When a search returns exactly one result, show the full info view automatically."),
  can_search: boolPerm("use /search"),
  can_clean: boolPerm("use /clean"),
  can_userinfo: boolPerm("use user info commands"),
  can_server: boolPerm("use server info"),
  can_channelinfo: boolPerm("use channel info"),
  can_messageinfo: boolPerm("use message info"),
  can_inviteinfo: boolPerm("use invite info"),
  can_roleinfo: boolPerm("use role info"),
  can_emojiinfo: boolPerm("use emoji info"),
  can_snowflake: boolPerm("look up snowflake IDs"),
  can_roles: boolPerm("use role listing utilities"),
  can_level: boolPerm("check permission levels"),
  can_context: boolPerm("use context utilities"),
  can_source: boolPerm("view message source"),
  can_nickname: boolPerm("change nicknames"),
  can_vcmove: boolPerm("move members in voice"),
  can_vckick: boolPerm("disconnect members from voice"),
  can_ping: boolPerm("use ping utilities"),
  can_about: boolPerm("use /about"),
  can_help: boolPerm("use /help"),
  can_reload_guild: boolPerm("reload the guild config from the database"),
  can_avatar: boolPerm("use avatar commands"),
  can_jumbo: boolPerm("use /jumbo"),
  can_stealemoji: boolPerm("use /stealemoji to copy custom emojis into this server"),
  can_info: boolPerm("use generic /info"),
  can_time: boolPerm("use time utilities"),
  can_convert_gif: boolPerm("use the Convert to GIF message context command"),
  can_create_quote: boolPerm("use the Create Quote message context command"),
});

export type UtilityConfig = z.infer<typeof zUtilityConfig>;

export const zUtilityPluginSection = z.strictObject({
  enabled: z.boolean().optional().describe("Turn the utility plugin on or off for this server."),
  config: zUtilityConfig.partial().optional(),
  overrides: z.array(zPluginOverride).optional(),
  replaceDefaultOverrides: z
    .boolean()
    .optional()
    .describe("When true, ignore Dreamliner's built-in default level grants for this plugin."),
});

export type UtilityPluginSection = z.infer<typeof zUtilityPluginSection>;
