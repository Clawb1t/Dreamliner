import { z } from "zod";
import { zPluginSection } from "./pluginSection.js";

/**
 * Characters: AI roleplay characters a server's managers create on the dashboard. Each one gets a
 * mentionable role and answers through a webhook with its own name and avatar. The characters
 * themselves live in the database (`characters` table); this section holds the plugin-wide
 * settings only.
 */

/** Characters per server, and character replies per server per UTC day. */
export const CHARACTERS_FREE_LIMIT = 2;
export const CHARACTERS_FREE_DAILY_REPLIES = 100;
export const CHARACTERS_ONE_LIMIT = 25;
export const CHARACTERS_ONE_DAILY_REPLIES = 3000;

export const MAX_CHARACTER_REPLY_CHARS = 1900;

const channelList = (help: string) => z.array(z.string()).max(100).default([]).describe(help);

export const zCharactersConfig = z.strictObject({
  allowed_channels: channelList(
    "Channels (or categories) where characters may talk. Empty means every channel the bot can read. A character's dedicated channels always work.",
  ),
  blocked_channels: channelList("Channels (or categories) where characters never talk, even when mentioned."),
  triggers: z
    .strictObject({
      reply: z.boolean().default(true).describe("Members can reply to a character's message to talk to it."),
      name: z
        .boolean()
        .default(false)
        .describe("Saying a character's name in a message makes it answer. Off by default, since names can come up by accident."),
      dedicated_channels: z
        .boolean()
        .default(true)
        .describe("Characters answer every message in their own dedicated channels."),
    })
    .default({})
    .describe("Ways members can start talking to a character, besides @mentioning its role (always on)."),
  cooldown_seconds: z
    .number()
    .int()
    .min(0)
    .max(300)
    .default(5)
    .describe("Seconds a member waits between replies from the same character."),
  member_daily_limit: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(0)
    .describe("Most character replies one member can get per day. 0 means no limit beyond the server's."),
  max_reply_chars: z
    .number()
    .int()
    .min(200)
    .max(MAX_CHARACTER_REPLY_CHARS)
    .default(1200)
    .describe("Longest character reply, in characters."),
  typing_text: z
    .string()
    .max(100)
    .default("*{name} is typing…*")
    .describe("Shown while a character is thinking, then replaced by its reply. {name} is the character's name."),
  can_talk: z.boolean().default(true).describe("Allow members to talk to the server's characters."),
});

export const zCharactersPluginSection = zPluginSection(zCharactersConfig.shape);

export type CharactersConfig = z.infer<typeof zCharactersConfig>;
