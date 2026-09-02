import { z } from "zod";

const snowflakeList = (description: string) =>
  z.array(z.string()).default([]).describe(description);

/** Shared filters / style that boards can inherit or override. */
export const zStarboardSharedOptions = z.strictObject({
  ignored_channels: snowflakeList(
    "Channel IDs where star reactions are ignored (messages there are never posted).",
  ),
  ignored_roles: snowflakeList(
    "Role IDs whose members cannot be starred (messages from these authors are ignored).",
  ),
  allow_bot_messages: z
    .boolean()
    .default(false)
    .describe("When true, messages from bots can be posted to the starboard."),
  allow_nsfw: z
    .boolean()
    .default(true)
    .describe("When true, messages from NSFW channels can be posted to the starboard."),
  color: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .optional()
    .describe("Embed color as a decimal integer (0–16777215)."),
});

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
  // Per-board filters (merged with global: channel/role lists union; booleans/color inherit when omitted)
  ignored_channels: z
    .array(z.string())
    .default([])
    .describe("Extra channel IDs ignored for this board (merged with global ignored_channels)."),
  ignored_roles: z
    .array(z.string())
    .default([])
    .describe("Extra role IDs ignored for this board (merged with global ignored_roles)."),
  allow_bot_messages: z
    .boolean()
    .optional()
    .describe("Override global allow_bot_messages for this board. Omit to inherit."),
  allow_nsfw: z
    .boolean()
    .optional()
    .describe("Override global allow_nsfw for this board. Omit to inherit."),
  color: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .optional()
    .describe("Override global embed color for this board. Omit to inherit."),
});

export const zStarboardConfig = z.strictObject({
  ...zStarboardSharedOptions.shape,
  boards: z
    .record(zStarboardBoard)
    .default({})
    .describe("Named starboard boards. Key is a short board name; value is the board settings."),
});

export const zStarboardPluginSection = z.strictObject({
  enabled: z.boolean().optional().describe("Turn starboard on or off for this server."),
  config: zStarboardConfig.partial().optional(),
});

export type StarboardBoard = z.infer<typeof zStarboardBoard>;
export type StarboardConfig = z.infer<typeof zStarboardConfig>;

/** Resolved board settings after applying global defaults. */
export type EffectiveStarboardBoard = StarboardBoard & {
  allow_bot_messages: boolean;
  allow_nsfw: boolean;
  ignored_channels: string[];
  ignored_roles: string[];
  color?: number;
};

export function resolveEffectiveStarboardBoard(
  globalConfig: StarboardConfig,
  board: StarboardBoard,
): EffectiveStarboardBoard {
  const globalChannels = globalConfig.ignored_channels ?? [];
  const globalRoles = globalConfig.ignored_roles ?? [];
  const boardChannels = board.ignored_channels ?? [];
  const boardRoles = board.ignored_roles ?? [];

  return {
    ...board,
    ignored_channels: [...new Set([...globalChannels, ...boardChannels])],
    ignored_roles: [...new Set([...globalRoles, ...boardRoles])],
    allow_bot_messages: board.allow_bot_messages ?? globalConfig.allow_bot_messages ?? false,
    allow_nsfw: board.allow_nsfw ?? globalConfig.allow_nsfw ?? true,
    color: board.color ?? globalConfig.color,
  };
}
