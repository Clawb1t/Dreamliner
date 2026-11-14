import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/** Permission-only. YouTube watcher rows live in their own DB table, built on the dashboard. */
export const zSocialConfig = z.strictObject({
  can_manage: boolPerm("create, edit, and delete social notifications (dashboard)"),
  can_view: boolPerm("view social notifications and run /social commands"),
});

export const zSocialPluginSection = zPluginSection(zSocialConfig.shape);

const colorInt = (description: string, fallback: number) =>
  z.number().int().min(0).max(0xffffff).default(fallback).describe(description);

const socialIcon = (description: string, options: readonly string[], fallback: string) =>
  z.enum(options as [string, ...string[]]).default(fallback).describe(description);

export const zSocialEmbedField = z.strictObject({
  name: z.string().max(256).default("").describe("Embed field name. Supports {video_title} and other placeholders."),
  value: z.string().max(1024).default("").describe("Embed field value. Supports placeholders."),
  inline: z.boolean().default(false).describe("Display the field inline."),
});

export const zSocialButton = z.strictObject({
  label: z.string().min(1).max(80).describe("Button label."),
  url: z.string().min(1).max(512).describe("https URL this button opens. Supports {video_url} and other placeholders."),
});

export const zSocialEmbedConfig = z.strictObject({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      "Include a Discord embed built by Dreamliner. Off by default — the plain message's video link is left for " +
        "Discord's own link unfurl to expand, which is usually all you need.",
    ),
  title: z.string().max(256).default("").describe("Embed title. Supports placeholders like {channel_name}."),
  title_url: z.string().max(512).default("").describe("Optional https URL the title links to. Supports placeholders."),
  description: z.string().max(4096).default("").describe("Embed description. Supports placeholders."),
  color: colorInt("Embed accent color as a decimal integer (0-16777215).", 0xff0000),
  author_name: z.string().max(256).default("").describe("Optional embed author name. Supports placeholders."),
  author_url: z.string().max(512).default("").describe("Optional https URL the author name links to."),
  author_icon: socialIcon("Author icon source.", ["none", "channel", "url"], "channel"),
  author_icon_url: z.string().max(512).default("").describe("Author icon URL when source is url."),
  thumbnail: socialIcon("Thumbnail image source.", ["none", "channel", "video", "url"], "none"),
  thumbnail_url: z.string().max(512).default("").describe("Thumbnail URL when source is url."),
  image: socialIcon("Large embed image source.", ["none", "video", "url"], "video"),
  image_url: z.string().max(512).default("").describe("Large embed image URL when source is url."),
  footer_text: z.string().max(2048).default("").describe("Footer text. Supports placeholders."),
  footer_icon: socialIcon("Footer icon source.", ["none", "channel", "url"], "none"),
  footer_icon_url: z.string().max(512).default("").describe("Footer icon URL when source is url."),
  timestamp: z.boolean().default(true).describe("Show the video's publish time in the embed footer."),
  fields: z.array(zSocialEmbedField).max(25).default([]).describe("Optional embed fields (max 25)."),
  buttons: z.array(zSocialButton).max(5).default([]).describe("Optional link buttons under the notification (max 5)."),
});

export type SocialConfig = z.infer<typeof zSocialConfig>;
export type SocialEmbedField = z.infer<typeof zSocialEmbedField>;
export type SocialButton = z.infer<typeof zSocialButton>;
export type SocialEmbedConfig = z.infer<typeof zSocialEmbedConfig>;

export function validateSocialEmbedConfig(input: unknown): SocialEmbedConfig {
  return zSocialEmbedConfig.parse(input);
}

/** Default embed for a newly created YouTube watcher — off by default, see `enabled`. */
export function buildDefaultSocialEmbedConfig(): SocialEmbedConfig {
  return zSocialEmbedConfig.parse({
    enabled: false,
    title: "New upload from {channel_name}!",
    description: "**{video_title}**",
    color: 0xff0000,
    author_name: "{channel_name}",
    author_url: "{channel_url}",
    author_icon: "channel",
    image: "video",
    timestamp: true,
    buttons: [{ label: "Watch on YouTube", url: "{video_url}" }],
  });
}

/** Default plain-text message for a newly created watcher, used when the embed is off. */
export const DEFAULT_SOCIAL_MESSAGE_CONTENT = "**{channel_name}** has posted {video_url}";

/** Default embed for a newly created Twitch watcher — off by default, see `enabled`. */
export function buildDefaultTwitchEmbedConfig(): SocialEmbedConfig {
  return zSocialEmbedConfig.parse({
    enabled: false,
    title: "{streamer_name} is live!",
    description: "**{stream_title}**",
    color: 0x9146ff,
    author_name: "{streamer_name}",
    author_url: "{streamer_url}",
    author_icon: "channel",
    image: "video",
    timestamp: true,
    buttons: [{ label: "Watch on Twitch", url: "{stream_url}" }],
  });
}

/** Default plain-text message for a newly created Twitch watcher, used when the embed is off. */
export const DEFAULT_TWITCH_MESSAGE_CONTENT = "**{streamer_name}** is live! {stream_url}";

// ---------------------------------------------------------------------------------------------
// Per-creator notification options (stored as JSON on each watcher row, not in guild config)
// ---------------------------------------------------------------------------------------------

const zSnowflakeList = z.array(z.string().regex(/^\d{5,25}$/)).max(10);

/** What a YouTube upload turned out to be (see classifyUpload in youtube.ts). */
export const YOUTUBE_UPLOAD_KINDS = ["video", "short", "live"] as const;
export type YoutubeUploadKind = (typeof YOUTUBE_UPLOAD_KINDS)[number];

/** What happens to a Twitch "went live" message once the stream ends. */
export const TWITCH_END_ACTIONS = ["none", "edit", "summary", "delete"] as const;
export type TwitchEndAction = (typeof TWITCH_END_ACTIONS)[number];

/** A separate message + role pings for one YouTube upload type. Off = use the creator's main message. */
export const zSocialTypeOverride = z.object({
  custom: z.boolean().default(false),
  message: z.string().max(2000).default(""),
  role_ids: zSnowflakeList.default([]),
});
export type SocialTypeOverride = z.infer<typeof zSocialTypeOverride>;

/**
 * Every field has a default, so rows saved before these options existed (stored as `{}`) parse
 * to the old behaviour: every upload type notifies, nothing happens when a stream ends.
 * Unknown keys are dropped rather than rejected.
 */
export const zSocialWatcherOptions = z.object({
  // YouTube upload types
  notify_videos: z.boolean().default(true),
  notify_shorts: z.boolean().default(true),
  notify_live: z.boolean().default(true),
  short_override: zSocialTypeOverride.default({ custom: false, message: "", role_ids: [] }),
  live_override: zSocialTypeOverride.default({ custom: false, message: "", role_ids: [] }),
  // Twitch stream lifecycle
  end_action: z.enum(TWITCH_END_ACTIONS).default("none"),
  live_updates: z.boolean().default(false),
  // Both: cooldown (Twitch: a restart within N minutes doesn't notify again; YouTube: uploads
  // within N minutes of the last notification still post, but without role pings).
  cooldown_minutes: z.number().int().min(0).max(720).default(0),
  // Both: quiet hours (notifications still post, silently and without role pings).
  quiet_enabled: z.boolean().default(false),
  quiet_start: z.number().int().min(0).max(23).default(23),
  quiet_end: z.number().int().min(0).max(23).default(8),
  quiet_timezone: z.string().min(1).max(64).default("UTC"),
  // Subscriber milestones (YouTube only: Twitch follower totals need a broadcaster's own login).
  milestones: z.boolean().default(false),
  /** Last announced milestone; -1 = not seeded yet (the next check records it without posting). */
  milestone_last: z.number().int().min(-1).default(-1),
});
export type SocialWatcherOptions = z.infer<typeof zSocialWatcherOptions>;

/** Parse stored options, falling back to defaults for anything missing or invalid. */
export function parseSocialWatcherOptions(raw: unknown): SocialWatcherOptions {
  const parsed = zSocialWatcherOptions.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // One bad field shouldn't wipe the rest: keep whatever parses on its own.
  const base = zSocialWatcherOptions.parse({});
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as (keyof SocialWatcherOptions)[]) {
    const single = zSocialWatcherOptions.shape[key].safeParse(source[key]);
    if (single.success) out[key] = single.data;
  }
  return out as SocialWatcherOptions;
}
