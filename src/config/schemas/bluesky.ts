import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/** Bluesky's brand blue, the default accent for post cards. */
export const BLUESKY_BLUE = 0x1185fe;

/** Per-server settings. Followed accounts live in their own DB table, built on the dashboard. */
export const zBlueskyConfig = z.strictObject({
  can_manage: boolPerm("add, edit, and remove Bluesky feeds (dashboard)"),
  can_view: boolPerm("list this server's Bluesky feeds with /bluesky feeds"),
  can_use: boolPerm("look up Bluesky profiles and manage their own connected account"),
  reaction_likes: z
    .boolean()
    .default(true)
    .describe(
      "Let members like a Bluesky post by reacting 💙 or 🩵 to any message that links it. Removing the reaction removes the like.",
    ),
  link_cards: z
    .boolean()
    .default(false)
    .describe("Reply to pasted bsky.app post links with an interactive post card that has Like and Repost buttons."),
});

export const zBlueskyPluginSection = zPluginSection(zBlueskyConfig.shape);

/** How one feed filters posts and what its card looks like. Stored as JSON on `bluesky_feeds.options`. */
export const zBlueskyFeedOptions = z.strictObject({
  accent_color: z.number().int().min(0).max(0xffffff).default(BLUESKY_BLUE).describe("Card accent color."),
  include_replies: z.boolean().default(false).describe("Post the account's replies to other people."),
  include_reposts: z.boolean().default(true).describe("Post things the account reposts."),
  include_quotes: z.boolean().default(true).describe("Post the account's quote posts."),
  media_only: z.boolean().default(false).describe("Only post when the post has images or video."),
  show_media: z.boolean().default(true).describe("Show the post's images, video thumbnail or link preview."),
  show_buttons: z.boolean().default(true).describe("Show the Like and Repost buttons."),
});

export type BlueskyConfig = z.infer<typeof zBlueskyConfig>;
export type BlueskyFeedOptions = z.infer<typeof zBlueskyFeedOptions>;

export const DEFAULT_BLUESKY_MESSAGE = "{creator_name} just posted on Bluesky!";

export function validateBlueskyFeedOptions(input: unknown): BlueskyFeedOptions {
  return zBlueskyFeedOptions.parse(input ?? {});
}
