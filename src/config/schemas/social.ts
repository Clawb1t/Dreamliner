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
  enabled: z.boolean().default(true).describe("Include a Discord embed with the notification."),
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

/** Default embed for a newly created YouTube watcher. */
export function buildDefaultSocialEmbedConfig(): SocialEmbedConfig {
  return zSocialEmbedConfig.parse({
    enabled: true,
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
