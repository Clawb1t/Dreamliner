import { z } from "zod";

const pluginOverrideSchema = z.strictObject({
  level: z.string().optional(),
  channel: z.string().optional(),
  category: z.string().optional(),
  user: z.string().optional(),
  config: z.record(z.unknown()),
});

export const zStarboardBoard = z.strictObject({
  channel_id: z.string(),
  stars_required: z.number().int().min(1).default(3),
  enabled: z.boolean().default(true),
  star_emoji: z.array(z.string()).default(["⭐"]),
  show_star_count: z.boolean().default(true),
  copy_full_embed: z.boolean().default(true),
  count_self_stars: z.boolean().default(false),
  color: z.number().int().optional(),
});

export const zStarboardConfig = z.strictObject({
  boards: z.record(zStarboardBoard).default({}),
  /** Channel IDs where star reactions are ignored (not posted to any board). */
  ignored_channels: z.array(z.string()).default([]),
});

export const zStarboardPluginSection = z.strictObject({
  enabled: z.boolean().optional(),
  config: zStarboardConfig.partial().optional(),
  overrides: z.array(pluginOverrideSchema).optional(),
  replaceDefaultOverrides: z.boolean().optional(),
});

export type StarboardBoard = z.infer<typeof zStarboardBoard>;
export type StarboardConfig = z.infer<typeof zStarboardConfig>;
