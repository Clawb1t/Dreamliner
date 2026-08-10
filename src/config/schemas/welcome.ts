import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";

const colorInt = (description: string, fallback?: number) => {
  const base = z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .describe(description);
  return fallback === undefined ? base.optional() : base.default(fallback);
};

const offsetInt = (description: string, min: number, max: number, fallback: number) =>
  z.number().int().min(min).max(max).default(fallback).describe(description);

export const zWelcomeEmbedField = z.strictObject({
  name: z.string().max(256).default("").describe("Embed field name."),
  value: z.string().max(1024).default("").describe("Embed field value. Supports placeholders."),
  inline: z.boolean().default(false).describe("Display the field inline."),
});

export const zWelcomeEmbedConfig = z.strictObject({
  enabled: z.boolean().default(false).describe("Include a Discord embed in the message."),
  title: z.string().max(256).default("").describe("Embed title. Supports placeholders."),
  description: z
    .string()
    .max(4096)
    .default("")
    .describe("Embed description. Supports placeholders."),
  color: colorInt("Embed accent color as a decimal integer (0–16777215).", 0x5662f5),
  author_name: z.string().max(256).default("").describe("Optional embed author name."),
  author_icon: z
    .enum(["none", "avatar", "guild", "url"])
    .default("none")
    .describe("Author icon source."),
  author_icon_url: z.string().max(512).default("").describe("Author icon URL when mode is url."),
  thumbnail: z
    .enum(["none", "avatar", "guild", "url"])
    .default("avatar")
    .describe("Thumbnail image source."),
  thumbnail_url: z.string().max(512).default("").describe("Thumbnail URL when mode is url."),
  // Legacy "card" values are rejected by the enum and caught as "none" (cards are standalone files).
  image: z
    .enum(["none", "url"])
    .catch("none")
    .default("none")
    .describe("Large embed image. Image cards attach as files, not embed images."),
  image_url: z.string().max(512).default("").describe("Image URL when mode is url."),
  footer_text: z.string().max(2048).default("").describe("Footer text. Supports placeholders."),
  footer_icon: z
    .enum(["none", "avatar", "guild", "url"])
    .default("none")
    .describe("Footer icon source."),
  footer_icon_url: z.string().max(512).default("").describe("Footer icon URL when mode is url."),
  timestamp: z.boolean().default(false).describe("Show the current time in the embed footer."),
  fields: z.array(zWelcomeEmbedField).max(25).default([]).describe("Optional embed fields."),
});

export const zWelcomeCardConfig = z.strictObject({
  enabled: z.boolean().default(false).describe("Generate and attach a welcome/leave image card."),
  background_type: z
    .enum(["color", "url", "asset"])
    .default("color")
    .describe("Card background source."),
  background_color: colorInt("Solid background color when type is color.", 0x1e1f22),
  background_url: z
    .string()
    .max(512)
    .default("")
    .describe("Background image URL when type is url."),
  background_asset_id: z
    .string()
    .max(128)
    .default("")
    .describe("Uploaded background asset id when type is asset."),
  avatar_layout: z
    .enum(["left", "center", "right"])
    .default("left")
    .describe("Preset position for the member avatar."),
  text_layout: z
    .enum(["beside", "below", "overlay_center", "overlay_bottom"])
    .default("beside")
    .describe("Preset position for greeting and subtitle text."),
  avatar_style: z
    .enum(["circle", "rounded_square"])
    .default("circle")
    .describe("Avatar shape."),
  show_avatar: z.boolean().default(true).describe("Draw the member avatar on the card."),
  show_accent_bar: z.boolean().default(true).describe("Draw the left accent bar."),
  greeting_text: z
    .string()
    .max(200)
    .default("Welcome {user_display}!")
    .describe("Primary card text. Supports placeholders."),
  subtitle_text: z
    .string()
    .max(200)
    .default("Member #{guild_member_count}")
    .describe("Secondary card text. Supports placeholders."),
  text_color: colorInt("Card text color.", 0xffffff),
  accent_color: colorInt("Accent bar / avatar ring color.", 0x5662f5),
  border_color: colorInt("Card border color.", 0x5662f5),
  border_width: offsetInt("Card border thickness in pixels.", 0, 32, 0),
  border_radius: offsetInt("Card corner radius in pixels.", 0, 80, 24),
  avatar_size: offsetInt("Avatar size in pixels.", 64, 240, 180),
  avatar_offset_x: offsetInt("Horizontal avatar nudge in pixels.", -400, 400, 0),
  avatar_offset_y: offsetInt("Vertical avatar nudge in pixels.", -200, 200, 0),
  text_offset_x: offsetInt("Horizontal text nudge in pixels.", -400, 400, 0),
  text_offset_y: offsetInt("Vertical text nudge in pixels.", -200, 200, 0),
  greeting_size: offsetInt("Greeting font size in pixels.", 18, 72, 44),
  subtitle_size: offsetInt("Subtitle font size in pixels.", 12, 48, 24),
  avatar_ring_width: offsetInt("Avatar ring thickness in pixels.", 0, 16, 6),
});

export const zWelcomeEventConfig = z.strictObject({
  enabled: z.boolean().default(false).describe("Send this event message."),
  channel_id: channelId("Channel where this event message is posted."),
  content: z
    .string()
    .max(2000)
    .default("")
    .describe("Optional message content above the embed/card. Supports placeholders."),
  embed: zWelcomeEmbedConfig.default({}),
  card: zWelcomeCardConfig.default({}),
});

export const zWelcomeDmConfig = z.strictObject({
  enabled: z.boolean().default(false).describe("Send a private welcome message to new members."),
  content: z
    .string()
    .max(2000)
    .default("")
    .describe("Optional DM content. Supports placeholders."),
  embed: zWelcomeEmbedConfig.default({}),
  card: zWelcomeCardConfig.default({}),
});

export const zWelcomeFirstMessageReact = z.strictObject({
  enabled: z
    .boolean()
    .default(false)
    .describe("React to a member's first message after joining."),
  emoji: z
    .string()
    .max(128)
    .default("")
    .describe("Server emoji id, unicode emoji, or <:name:id> / <a:name:id>."),
});

export const zWelcomeWaveButton = z.strictObject({
  enabled: z
    .boolean()
    .default(false)
    .describe("Add a Wave button on join channel welcomes."),
  label: z.string().max(80).default("Wave").describe("Button label before the tally."),
  emoji: z
    .string()
    .max(128)
    .default("👋")
    .describe("Button emoji (unicode, emoji id, or <:name:id>)."),
});

export const zWelcomeMessageConfig = z.strictObject({
  join: zWelcomeEventConfig.default({
    enabled: true,
    content: "Welcome {user} to **{guild}**!",
  }),
  leave: zWelcomeEventConfig.default({}),
  dm: zWelcomeDmConfig.default({}),
  first_message_react: zWelcomeFirstMessageReact.default({}),
  delete_join_on_early_leave: z
    .boolean()
    .default(false)
    .describe("Delete the join welcome message if the member leaves within 24 hours."),
  wave_button: zWelcomeWaveButton.default({}),
  can_set: boolPerm("configure the welcomer"),
  can_test: boolPerm("test welcomer messages"),
  can_disable: boolPerm("disable welcomer messages"),
});

export type WelcomeEmbedField = z.infer<typeof zWelcomeEmbedField>;
export type WelcomeEmbedConfig = z.infer<typeof zWelcomeEmbedConfig>;
export type WelcomeCardConfig = z.infer<typeof zWelcomeCardConfig>;
export type WelcomeEventConfig = z.infer<typeof zWelcomeEventConfig>;
export type WelcomeDmConfig = z.infer<typeof zWelcomeDmConfig>;
export type WelcomeFirstMessageReact = z.infer<typeof zWelcomeFirstMessageReact>;
export type WelcomeWaveButton = z.infer<typeof zWelcomeWaveButton>;
export type WelcomeMessageConfig = z.infer<typeof zWelcomeMessageConfig>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripLegacyCardEmbedImage(event: Record<string, unknown>): void {
  if (!isPlainObject(event.embed)) return;
  if (event.embed.image === "card") event.embed.image = "none";
}

/** Migrate legacy `{ channel_id, message }` welcome configs into join/leave/dm. */
export function migrateWelcomeMessageInConfig(value: Record<string, unknown>): boolean {
  const plugins = value.plugins;
  if (!isPlainObject(plugins)) return false;
  const section = plugins.welcome_message;
  if (!isPlainObject(section)) return false;
  const config = section.config;
  if (!isPlainObject(config)) return false;

  let changed = false;

  const hasLegacy = "channel_id" in config || "message" in config;
  const hasNew = isPlainObject(config.join) || isPlainObject(config.leave) || isPlainObject(config.dm);

  if (hasLegacy && (!hasNew || hasLegacy)) {
    const legacyChannel =
      typeof config.channel_id === "string" && config.channel_id.trim()
        ? config.channel_id.trim()
        : undefined;
    const legacyMessage =
      typeof config.message === "string" && config.message.trim()
        ? config.message
        : "Welcome {user} to **{guild}**!";

    if ("channel_id" in config) {
      delete config.channel_id;
      changed = true;
    }
    if ("message" in config) {
      delete config.message;
      changed = true;
    }

    if (!isPlainObject(config.join)) {
      config.join = {
        enabled: true,
        ...(legacyChannel ? { channel_id: legacyChannel } : {}),
        content: legacyMessage,
        embed: { enabled: false },
        card: { enabled: false },
      };
      changed = true;
    } else if (hasLegacy) {
      const join = config.join;
      if (legacyChannel && typeof join.channel_id !== "string") {
        join.channel_id = legacyChannel;
        changed = true;
      }
      if (typeof join.content !== "string" || !join.content.trim()) {
        join.content = legacyMessage;
        changed = true;
      }
    }

    if (!isPlainObject(config.leave)) {
      config.leave = { enabled: false, content: "", embed: { enabled: false }, card: { enabled: false } };
      changed = true;
    }
    if (!isPlainObject(config.dm)) {
      config.dm = { enabled: false, content: "", embed: { enabled: false }, card: { enabled: false } };
      changed = true;
    }
  }

  for (const key of ["join", "leave", "dm"] as const) {
    if (isPlainObject(config[key])) {
      const before = JSON.stringify(config[key]);
      stripLegacyCardEmbedImage(config[key] as Record<string, unknown>);
      if (JSON.stringify(config[key]) !== before) changed = true;
    }
  }

  if (!isPlainObject(config.first_message_react)) {
    config.first_message_react = { enabled: false, emoji: "" };
    changed = true;
  }

  if (typeof config.delete_join_on_early_leave !== "boolean") {
    config.delete_join_on_early_leave = false;
    changed = true;
  }

  if (!isPlainObject(config.wave_button)) {
    config.wave_button = { enabled: false, label: "Wave", emoji: "👋" };
    changed = true;
  }

  return changed;
}
