import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type BaseMessageOptions,
} from "discord.js";
import type { SocialEmbedConfig } from "../../../config/schemas/social.js";
import type { SocialWatcherRow } from "./store.js";
import type { LatestUpload } from "./youtube.js";

/** Tokens available in the top message, every embed text field, and button URLs. */
export const SOCIAL_TOKENS = [
  "video_title",
  "video_url",
  "video_thumbnail",
  "video_id",
  "published_at",
  "channel_name",
  "channel_handle",
  "channel_url",
  "channel_avatar",
] as const;
export type SocialTokenKey = (typeof SOCIAL_TOKENS)[number];

export function buildSocialTokens(watcher: SocialWatcherRow, video: LatestUpload): Record<SocialTokenKey, string> {
  return {
    video_title: video.title,
    video_url: video.url,
    video_thumbnail: video.thumbnailUrl,
    video_id: video.videoId,
    published_at: `<t:${Math.floor(video.publishedAt.getTime() / 1000)}:R>`,
    channel_name: watcher.sourceChannelName,
    channel_handle: watcher.sourceChannelHandle ?? "",
    channel_url: watcher.sourceChannelUrl,
    channel_avatar: watcher.sourceChannelAvatarUrl ?? "",
  };
}

const TOKEN_RE = /\{(video_title|video_url|video_thumbnail|video_id|published_at|channel_name|channel_handle|channel_url|channel_avatar)\}/g;

export function interpolateSocialTokens(text: string, tokens: Record<SocialTokenKey, string>): string {
  return text.replace(TOKEN_RE, (_m, key: SocialTokenKey) => tokens[key] ?? "");
}

function resolveIconUrl(
  source: string,
  customUrl: string,
  tokens: Record<SocialTokenKey, string>,
): string | undefined {
  if (source === "channel") return tokens.channel_avatar || undefined;
  if (source === "video") return tokens.video_thumbnail || undefined;
  if (source === "url") return customUrl.trim() ? interpolateSocialTokens(customUrl, tokens) : undefined;
  return undefined;
}

function buildEmbed(embedConfig: SocialEmbedConfig, tokens: Record<SocialTokenKey, string>): EmbedBuilder | null {
  if (!embedConfig.enabled) return null;
  const embed = new EmbedBuilder();

  if (embedConfig.title.trim()) embed.setTitle(interpolateSocialTokens(embedConfig.title, tokens).slice(0, 256));
  if (embedConfig.title_url.trim()) {
    const url = interpolateSocialTokens(embedConfig.title_url, tokens).trim();
    if (url) embed.setURL(url);
  }
  if (embedConfig.description.trim()) {
    embed.setDescription(interpolateSocialTokens(embedConfig.description, tokens).slice(0, 4096));
  }
  embed.setColor(embedConfig.color);

  if (embedConfig.author_name.trim()) {
    embed.setAuthor({
      name: interpolateSocialTokens(embedConfig.author_name, tokens).slice(0, 256),
      iconURL: resolveIconUrl(embedConfig.author_icon, embedConfig.author_icon_url, tokens),
      url: embedConfig.author_url.trim() ? interpolateSocialTokens(embedConfig.author_url, tokens) : undefined,
    });
  }

  const thumbnailUrl = resolveIconUrl(embedConfig.thumbnail, embedConfig.thumbnail_url, tokens);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);

  const imageUrl = resolveIconUrl(embedConfig.image, embedConfig.image_url, tokens);
  if (imageUrl) embed.setImage(imageUrl);

  if (embedConfig.footer_text.trim()) {
    embed.setFooter({
      text: interpolateSocialTokens(embedConfig.footer_text, tokens).slice(0, 2048),
      iconURL: resolveIconUrl(embedConfig.footer_icon, embedConfig.footer_icon_url, tokens),
    });
  }
  if (embedConfig.timestamp) embed.setTimestamp(new Date());

  for (const field of embedConfig.fields.slice(0, 25)) {
    const name = interpolateSocialTokens(field.name, tokens).slice(0, 256).trim();
    const value = interpolateSocialTokens(field.value, tokens).slice(0, 1024).trim();
    if (!name || !value) continue;
    embed.addFields({ name, value, inline: field.inline });
  }

  return embed;
}

function buildButtonsRow(embedConfig: SocialEmbedConfig, tokens: Record<SocialTokenKey, string>): ActionRowBuilder<ButtonBuilder> | null {
  const buttons = embedConfig.buttons.slice(0, 5).filter((b) => b.label.trim() && b.url.trim());
  if (!buttons.length) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...buttons.map((b) =>
      new ButtonBuilder()
        .setLabel(b.label.slice(0, 80))
        .setStyle(ButtonStyle.Link)
        .setURL(interpolateSocialTokens(b.url, tokens)),
    ),
  );
}

function buildContent(watcher: SocialWatcherRow, tokens: Record<SocialTokenKey, string>): string {
  const rendered = interpolateSocialTokens(watcher.messageContent, tokens);
  const roleMentions = watcher.mentionRoleIds.map((id) => `<@&${id}>`).join(" ");

  if (!roleMentions) return rendered.slice(0, 2000);
  if (rendered.includes("{roles}")) return rendered.replace(/\{roles\}/g, roleMentions).slice(0, 2000);
  return rendered ? `${roleMentions} ${rendered}`.slice(0, 2000) : roleMentions.slice(0, 2000);
}

export function buildNotificationPayload(watcher: SocialWatcherRow, video: LatestUpload): BaseMessageOptions {
  const tokens = buildSocialTokens(watcher, video);
  const embed = buildEmbed(watcher.embedConfig, tokens);
  const buttonsRow = buildButtonsRow(watcher.embedConfig, tokens);
  const content = buildContent(watcher, tokens);

  return {
    content: content || undefined,
    embeds: embed ? [embed] : [],
    components: buttonsRow ? [buttonsRow] : [],
    allowedMentions: { roles: watcher.mentionRoleIds, parse: [] },
  };
}

/** Send a video notification for a watcher. Never throws; logs and returns false on failure. */
export async function sendNotification(client: Client, watcher: SocialWatcherRow, video: LatestUpload): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(watcher.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      console.warn(`[social] watcher ${watcher.id}: target channel ${watcher.discordChannelId} is unavailable.`);
      return false;
    }
    await channel.send(buildNotificationPayload(watcher, video));
    return true;
  } catch (error) {
    console.error(`[social] watcher ${watcher.id}: failed to send notification:`, error);
    return false;
  }
}
