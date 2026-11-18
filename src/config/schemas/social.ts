import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/** Permission-only. Feeds live in their own DB tables (feed_sources / feed_subscriptions), built on the dashboard. */
export const zSocialConfig = z.strictObject({
  can_manage: boolPerm("create, edit, and delete notification feeds (dashboard), and pause/resume/test them with /notifications"),
  can_view: boolPerm("view notification feeds and run /notifications list"),
});

export const zSocialPluginSection = zPluginSection(zSocialConfig.shape);

export type SocialConfig = z.infer<typeof zSocialConfig>;

// ---------------------------------------------------------------------------------------------
// Feed message design (stored as JSON on each feed_subscriptions row, not in guild config)
// ---------------------------------------------------------------------------------------------

const colorInt = (description: string, fallback: number) =>
  z.number().int().min(0).max(0xffffff).default(fallback).describe(description);

const iconSource = (description: string, options: readonly string[], fallback: string) =>
  z.enum(options as [string, ...string[]]).default(fallback).describe(description);

export const zFeedCardField = z.strictObject({
  name: z.string().max(256).default("").describe("Field name. Supports tokens."),
  value: z.string().max(1024).default("").describe("Field value. Supports tokens."),
  inline: z.boolean().default(false).describe("Display the field inline."),
});

export const zFeedButton = z.strictObject({
  label: z.string().min(1).max(80).describe("Button label."),
  url: z.string().min(1).max(512).describe("https URL this button opens. Supports tokens like {url}."),
});

/**
 * The optional card. Icon sources: "channel" is the source's icon (channel avatar, site icon),
 * "video" is the item's image (thumbnail, article image), "url" is a custom URL.
 */
export const zFeedCard = z.object({
  enabled: z.boolean().default(false).describe("Post a card. Off posts the text only, and Discord previews the link itself."),
  title: z.string().max(256).default("").describe("Card title. Supports tokens."),
  title_url: z.string().max(512).default("").describe("Optional https URL the title links to. Supports tokens."),
  description: z.string().max(4096).default("").describe("Card text. Supports tokens."),
  color: colorInt("Accent color as a decimal integer (0-16777215).", 0x5865f2),
  author_name: z.string().max(256).default("").describe("Small line above the title. Supports tokens."),
  author_url: z.string().max(512).default("").describe("Optional https URL the author line links to."),
  author_icon: iconSource("Author icon source (kept for older messages; cards show it as the thumbnail when no thumbnail is set).", ["none", "channel", "url"], "channel"),
  author_icon_url: z.string().max(512).default("").describe("Author icon URL when source is url."),
  thumbnail: iconSource("Thumbnail source.", ["none", "channel", "video", "url"], "none"),
  thumbnail_url: z.string().max(512).default("").describe("Thumbnail URL when source is url."),
  image: iconSource("Large image source.", ["none", "video", "url"], "video"),
  image_url: z.string().max(512).default("").describe("Large image URL when source is url."),
  footer_text: z.string().max(2048).default("").describe("Footer text. Supports tokens."),
  footer_icon: iconSource("Footer icon source (unused in cards, kept for older messages).", ["none", "channel", "url"], "none"),
  footer_icon_url: z.string().max(512).default("").describe("Footer icon URL when source is url."),
  timestamp: z.boolean().default(true).describe("Show the item's publish time in the footer."),
  fields: z.array(zFeedCardField).max(25).default([]).describe("Optional fields (max 25)."),
});

export const zFeedMessage = z.object({
  content: z.string().max(2000).default("").describe("Text above the card. Supports tokens; {roles} places the role pings."),
  embed: zFeedCard.default({}),
  buttons: z.array(zFeedButton).max(5).default([]).describe("Link buttons (max 5)."),
});

export type FeedCardField = z.infer<typeof zFeedCardField>;
export type FeedButton = z.infer<typeof zFeedButton>;
export type FeedCard = z.infer<typeof zFeedCard>;
export type FeedMessage = z.infer<typeof zFeedMessage>;

// ---------------------------------------------------------------------------------------------
// Filters and options (JSON on each feed_subscriptions row)
// ---------------------------------------------------------------------------------------------

const zKeywordList = z.array(z.string().trim().min(1).max(100)).max(25);
const zSnowflakeList = z.array(z.string().regex(/^\d{5,25}$/)).max(10);

export const zFeedFilters = z.object({
  /** Post only items whose title or summary contains at least one of these (case-insensitive). */
  include_keywords: zKeywordList.default([]),
  /** Never post items whose title or summary contains any of these. */
  exclude_keywords: zKeywordList.default([]),
  /** Post only items tagged with one of these categories/tags (case-insensitive). Empty = any. */
  categories: zKeywordList.default([]),
  /** Steam: only announcements Steam tags as patch notes. */
  steam_patch_notes_only: z.boolean().default(false),
  /** YouTube upload types. */
  youtube_videos: z.boolean().default(true),
  youtube_shorts: z.boolean().default(true),
  youtube_live: z.boolean().default(true),
});
export type FeedFilters = z.infer<typeof zFeedFilters>;

/** What a YouTube upload turned out to be (see classifyUpload in logic.ts). */
export const YOUTUBE_UPLOAD_KINDS = ["video", "short", "live"] as const;
export type YoutubeUploadKind = (typeof YOUTUBE_UPLOAD_KINDS)[number];

/** What happens to a Twitch "went live" message once the stream ends. */
export const TWITCH_END_ACTIONS = ["none", "edit", "summary", "delete"] as const;
export type TwitchEndAction = (typeof TWITCH_END_ACTIONS)[number];

/** A separate message + role pings for one YouTube upload type. Off = use the feed's main message. */
export const zSocialTypeOverride = z.object({
  custom: z.boolean().default(false),
  message: z.string().max(2000).default(""),
  role_ids: zSnowflakeList.default([]),
});
export type SocialTypeOverride = z.infer<typeof zSocialTypeOverride>;

/**
 * Every field has a default, so rows saved before an option existed parse to the old behaviour.
 * Unknown keys are dropped rather than rejected.
 */
export const zFeedOptions = z.object({
  // YouTube per-type messages
  short_override: zSocialTypeOverride.default({ custom: false, message: "", role_ids: [] }),
  live_override: zSocialTypeOverride.default({ custom: false, message: "", role_ids: [] }),
  // Twitch stream lifecycle
  end_action: z.enum(TWITCH_END_ACTIONS).default("none"),
  live_updates: z.boolean().default(false),
  // Cooldown. Twitch: a restart within N minutes doesn't notify again. Everything else: items
  // within N minutes of the last notification still post, but without role pings.
  cooldown_minutes: z.number().int().min(0).max(720).default(0),
  // Quiet hours (notifications still post, silently and without role pings).
  quiet_enabled: z.boolean().default(false),
  quiet_start: z.number().int().min(0).max(23).default(23),
  quiet_end: z.number().int().min(0).max(23).default(8),
  quiet_timezone: z.string().min(1).max(64).default("UTC"),
  // Subscriber milestones (YouTube only: Twitch follower totals need a broadcaster's own login).
  milestones: z.boolean().default(false),
  /** Last announced milestone; -1 = not seeded yet (the next check records it without posting). */
  milestone_last: z.number().int().min(-1).default(-1),
});
export type FeedOptions = z.infer<typeof zFeedOptions>;
/** Older name, still used by the pure helpers in logic.ts. */
export type SocialWatcherOptions = FeedOptions;

/** Parse stored JSON with `schema`, keeping every field that parses on its own when the whole fails. */
function parseLenient<S extends z.ZodObject<z.ZodRawShape>>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const base = schema.parse({}) as Record<string, unknown>;
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(schema.shape)) {
    const single = (schema.shape[key] as z.ZodTypeAny).safeParse(source[key]);
    if (single.success) out[key] = single.data;
  }
  return out as z.infer<S>;
}

export function parseFeedOptions(raw: unknown): FeedOptions {
  return parseLenient(zFeedOptions, raw);
}
export const parseSocialWatcherOptions = parseFeedOptions;

export function parseFeedFilters(raw: unknown): FeedFilters {
  return parseLenient(zFeedFilters, raw);
}

export function parseFeedMessage(raw: unknown): FeedMessage {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const card = parseLenient(zFeedCard, source.embed);
  const fields = zFeedCard.shape.fields.safeParse(card.fields);
  const content = zFeedMessage.shape.content.safeParse(source.content);
  const buttons = zFeedMessage.shape.buttons.safeParse(source.buttons);
  return {
    content: content.success ? content.data : "",
    embed: { ...card, fields: fields.success ? fields.data : [] },
    buttons: buttons.success ? buttons.data : [],
  };
}

export type FeedSourceType = "youtube" | "twitch" | "rss" | "steam" | "github" | "statuspage" | "newswire";

/** Default plain-text messages for creators (the card is off: Discord's own link preview shows the video/stream). */
export const DEFAULT_SOCIAL_MESSAGE_CONTENT = "**{channel_name}** has posted {video_url}";
export const DEFAULT_TWITCH_MESSAGE_CONTENT = "**{streamer_name}** is live! {stream_url}";

const BUTTON_LABELS: Record<FeedSourceType, string> = {
  youtube: "Watch on YouTube",
  twitch: "Watch on Twitch",
  rss: "Read more",
  steam: "Read on Steam",
  github: "View release",
  statuspage: "View status",
  newswire: "Read more",
};

const CARD_COLORS: Record<FeedSourceType, number> = {
  youtube: 0xff0033,
  twitch: 0x9146ff,
  rss: 0xf26522,
  steam: 0x1b2838,
  github: 0x24292f,
  statuspage: 0x43b581,
  newswire: 0x5865f2,
};

/** A good-looking message for a new feed, so creating one needs no editing at all. */
export function defaultFeedMessage(type: FeedSourceType, color?: number | null): FeedMessage {
  if (type === "youtube") {
    return zFeedMessage.parse({
      content: DEFAULT_SOCIAL_MESSAGE_CONTENT,
      embed: {
        enabled: false,
        title: "{video_title}",
        title_url: "{video_url}",
        description: "New {upload_type} from **{channel_name}**",
        color: CARD_COLORS.youtube,
        author_name: "{channel_name}",
        author_url: "{channel_url}",
        thumbnail: "channel",
        image: "video",
      },
      buttons: [],
    });
  }
  if (type === "twitch") {
    return zFeedMessage.parse({
      content: DEFAULT_TWITCH_MESSAGE_CONTENT,
      embed: {
        enabled: false,
        title: "{stream_title}",
        title_url: "{stream_url}",
        description: "**{streamer_name}** is live, playing {game_name}",
        color: CARD_COLORS.twitch,
        author_name: "{streamer_name}",
        author_url: "{streamer_url}",
        thumbnail: "channel",
        image: "video",
      },
      buttons: [],
    });
  }
  return zFeedMessage.parse({
    content: "",
    embed: {
      enabled: true,
      title: "{title}",
      title_url: "{url}",
      description: "{summary}",
      color: color ?? CARD_COLORS[type],
      author_name: "{source}",
      author_url: "{source_url}",
      thumbnail: "none",
      image: "video",
      timestamp: true,
    },
    buttons: [{ label: BUTTON_LABELS[type], url: "{url}" }],
  });
}
