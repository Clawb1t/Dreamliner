import { z } from "zod";
import { zPluginOverride } from "./pluginSection.js";

export const zStarboardBoard = z.strictObject({
  channel_id: z.string().describe("Channel ID where starred messages are posted."),
  stars_required: z
    .number()
    .int()
    .min(1)
    .default(3)
    .describe("How many star reactions are needed before a message is posted."),
  enabled: z.boolean().default(true).describe("Whether this board is active."),
  star_emoji: z
    .array(z.string())
    .default(["⭐"])
    .describe("Emojis that count as stars for this board."),
  show_star_count: z
    .boolean()
    .default(true)
    .describe("Show the star count on the board post."),
  copy_full_embed: z
    .boolean()
    .default(true)
    .describe("Copy embeds from the original message when possible."),
  count_self_stars: z
    .boolean()
    .default(false)
    .describe("Count a user's star on their own message."),
  color: z.number().int().optional().describe("Optional embed color as an integer."),
});

export const zStarboardConfig = z.strictObject({
  boards: z
    .record(zStarboardBoard)
    .default({})
    .describe("Named starboard boards. Key is a short board name; value is the board settings."),
  ignored_channels: z
    .array(z.string())
    .default([])
    .describe("Channel IDs where star reactions are ignored and never posted."),
});

export const zStarboardPluginSection = z.strictObject({
  enabled: z.boolean().optional().describe("Turn starboard on or off for this server."),
  config: zStarboardConfig.partial().optional(),
  overrides: z.array(zPluginOverride).optional(),
  replaceDefaultOverrides: z
    .boolean()
    .optional()
    .describe("When true, ignore Dreamliner's built-in default level grants for this plugin."),
});

export type StarboardBoard = z.infer<typeof zStarboardBoard>;
export type StarboardConfig = z.infer<typeof zStarboardConfig>;
