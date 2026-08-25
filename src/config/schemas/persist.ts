import { z } from "zod";

const colorInt = (description: string, fallback?: number) => {
  const base = z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .describe(description);
  return fallback === undefined ? base.optional() : base.default(fallback);
};

const persistIcon = (description: string, fallback: "none" | "guild" | "bot" | "url" = "none") =>
  z
    .enum(["none", "guild", "bot", "url"])
    .default(fallback)
    .describe(`${description} none, guild icon, bot avatar, or a custom URL.`);

export const zPersistEmbedField = z.strictObject({
  name: z.string().max(256).default("").describe("Embed field name. Supports {guild} placeholders."),
  value: z.string().max(1024).default("").describe("Embed field value. Supports placeholders."),
  inline: z.boolean().default(false).describe("Display the field inline."),
});

export const zPersistEmbedConfig = z.strictObject({
  enabled: z.boolean().default(false).describe("Include a Discord embed."),
  title: z.string().max(256).default("").describe("Embed title. Supports placeholders like {guild}."),
  title_url: z
    .string()
    .max(512)
    .default("")
    .describe("Optional https URL the title links to."),
  description: z
    .string()
    .max(4096)
    .default("")
    .describe("Embed description. Supports placeholders."),
  color: colorInt("Embed accent color as a decimal integer (0–16777215).", 0x5662f5),
  author_name: z.string().max(256).default("").describe("Optional embed author name."),
  author_url: z.string().max(512).default("").describe("Optional https URL the author name links to."),
  author_icon: persistIcon("Author icon source."),
  author_icon_url: z.string().max(512).default("").describe("Author icon URL when source is url."),
  thumbnail: persistIcon("Thumbnail image source."),
  thumbnail_url: z.string().max(512).default("").describe("Thumbnail URL when source is url."),
  image_url: z.string().max(512).default("").describe("Large embed image URL (https). Leave empty for none."),
  footer_text: z.string().max(2048).default("").describe("Footer text. Supports placeholders."),
  footer_icon: persistIcon("Footer icon source."),
  footer_icon_url: z.string().max(512).default("").describe("Footer icon URL when source is url."),
  timestamp: z.boolean().default(false).describe("Show the current time in the embed footer."),
  fields: z.array(zPersistEmbedField).max(25).default([]).describe("Optional embed fields (max 25)."),
});

export const zPersistButton = z.strictObject({
  label: z.string().min(1).max(80).describe("Button label."),
  url: z.string().min(1).max(512).describe("https URL this button opens."),
  emoji: z
    .string()
    .max(128)
    .default("")
    .describe("Optional button emoji (unicode or <:name:id>)."),
});

export const zPersistSticky = z.strictObject({
  enabled: z.boolean().default(true).describe("Turn this sticky on or off without deleting it."),
  name: z
    .string()
    .max(80)
    .default("")
    .describe("Optional label in the dashboard. Also used as the webhook username fallback."),
  channel_id: z
    .string()
    .min(1)
    .describe("Channel where this sticky message stays at the bottom."),
  content: z
    .string()
    .max(2000)
    .default("")
    .describe(
      "Optional text above the embed. Supports placeholders like {guild}, {channel}, {member_count}. Can be empty if an embed or buttons are set.",
    ),
  delay_seconds: z
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(0)
    .describe(
      "Seconds to wait after a new message before deleting and resending the sticky. 0 resends immediately.",
    ),
  message_threshold: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(0)
    .describe(
      "Other messages that must be sent in the channel before the sticky is allowed to resend. 0 disables this and only delay_seconds gates the resend. Both rules apply together: once this many messages have been sent, the sticky still waits for delay_seconds of quiet before it actually bumps.",
    ),
  embed: zPersistEmbedConfig.default({}).describe("Optional Discord embed."),
  buttons: z
    .array(zPersistButton)
    .max(5)
    .default([])
    .describe("Optional link buttons under the sticky (max 5)."),
  webhook: z
    .boolean()
    .default(false)
    .describe(
      "Send as a webhook with a custom name and avatar. Requires Manage Webhooks. Falls back to the bot if a webhook cannot be created.",
    ),
  webhook_name: z
    .string()
    .max(80)
    .default("")
    .describe("Webhook display name. Defaults to the sticky name, then Sticky."),
  webhook_avatar_url: z
    .string()
    .max(512)
    .default("")
    .describe("Webhook avatar image URL (https)."),
  silent: z
    .boolean()
    .default(false)
    .describe("Send without notifying members (suppress notifications)."),
  suppress_embeds: z
    .boolean()
    .default(false)
    .describe("Do not unfurl links in the text content into extra embeds."),
  mention_users: z.boolean().default(true).describe("Allow @user mentions in the sticky text."),
  mention_roles: z.boolean().default(true).describe("Allow @role mentions in the sticky text."),
  mention_everyone: z
    .boolean()
    .default(false)
    .describe("Allow @everyone / @here in the sticky text."),
  ignore_bots: z
    .boolean()
    .default(false)
    .describe("Do not bump the sticky when a bot posts in the channel."),
  ignore_webhooks: z
    .boolean()
    .default(false)
    .describe("Do not bump the sticky when a webhook posts in the channel."),
});

export const zPersistConfig = z.strictObject({
  messages: z
    .array(zPersistSticky)
    .default([])
    .describe(
      "Sticky messages. Add one entry per channel. If two entries share a channel, the last enabled one is used.",
    ),
});

export type PersistEmbedField = z.infer<typeof zPersistEmbedField>;
export type PersistEmbedConfig = z.infer<typeof zPersistEmbedConfig>;
export type PersistButton = z.infer<typeof zPersistButton>;
export type PersistSticky = z.infer<typeof zPersistSticky>;
export type PersistConfig = z.infer<typeof zPersistConfig>;
