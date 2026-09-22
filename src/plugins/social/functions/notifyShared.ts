/**
 * Platform-agnostic notification building shared by notify.ts (YouTube) and notifyTwitch.ts:
 * token interpolation, embed/button/content rendering, and sending. Each platform module
 * supplies its own token record shape and watcher/media types; everything here only cares about
 * the generic SocialEmbedConfig + message/mention-role fields all watcher rows share.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type BaseMessageOptions,
} from "discord.js";
import type { SocialEmbedConfig } from "../../../config/schemas/social.js";
import { getLogger } from "../../../core/logger.js";
const log = getLogger("social");

export type NotifiableWatcher = {
  id: number;
  discordChannelId: string;
  messageContent: string;
  mentionRoleIds: string[];
  embedConfig: SocialEmbedConfig;
};

/** Replace every `{token}` present in `tokens` — the regex is built from its keys, so this works for any platform's token set. */
export function interpolateTokens(text: string, tokens: Record<string, string>): string {
  const keys = Object.keys(tokens);
  if (!keys.length) return text;
  const re = new RegExp(`\\{(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\}`, "g");
  return text.replace(re, (_m, key: string) => tokens[key] ?? "");
}

function resolveIconUrl(
  source: string,
  customUrl: string,
  tokens: Record<string, string>,
  avatarKey: string,
  mediaKey: string,
): string | undefined {
  if (source === "channel") return tokens[avatarKey] || undefined;
  if (source === "video") return tokens[mediaKey] || undefined;
  if (source === "url") return customUrl.trim() ? interpolateTokens(customUrl, tokens) : undefined;
  return undefined;
}

function buildEmbed(
  embedConfig: SocialEmbedConfig,
  tokens: Record<string, string>,
  avatarKey: string,
  mediaKey: string,
): EmbedBuilder | null {
  if (!embedConfig.enabled) return null;
  const embed = new EmbedBuilder();

  if (embedConfig.title.trim()) embed.setTitle(interpolateTokens(embedConfig.title, tokens).slice(0, 256));
  if (embedConfig.title_url.trim()) {
    const url = interpolateTokens(embedConfig.title_url, tokens).trim();
    if (url) embed.setURL(url);
  }
  if (embedConfig.description.trim()) {
    embed.setDescription(interpolateTokens(embedConfig.description, tokens).slice(0, 4096));
  }
  embed.setColor(embedConfig.color);

  if (embedConfig.author_name.trim()) {
    embed.setAuthor({
      name: interpolateTokens(embedConfig.author_name, tokens).slice(0, 256),
      iconURL: resolveIconUrl(embedConfig.author_icon, embedConfig.author_icon_url, tokens, avatarKey, mediaKey),
      url: embedConfig.author_url.trim() ? interpolateTokens(embedConfig.author_url, tokens) : undefined,
    });
  }

  const thumbnailUrl = resolveIconUrl(embedConfig.thumbnail, embedConfig.thumbnail_url, tokens, avatarKey, mediaKey);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);

  const imageUrl = resolveIconUrl(embedConfig.image, embedConfig.image_url, tokens, avatarKey, mediaKey);
  if (imageUrl) embed.setImage(imageUrl);

  if (embedConfig.footer_text.trim()) {
    embed.setFooter({
      text: interpolateTokens(embedConfig.footer_text, tokens).slice(0, 2048),
      iconURL: resolveIconUrl(embedConfig.footer_icon, embedConfig.footer_icon_url, tokens, avatarKey, mediaKey),
    });
  }
  if (embedConfig.timestamp) embed.setTimestamp(new Date());

  for (const field of embedConfig.fields.slice(0, 25)) {
    const name = interpolateTokens(field.name, tokens).slice(0, 256).trim();
    const value = interpolateTokens(field.value, tokens).slice(0, 1024).trim();
    if (!name || !value) continue;
    embed.addFields({ name, value, inline: field.inline });
  }

  return embed;
}

function buildButtonsRow(embedConfig: SocialEmbedConfig, tokens: Record<string, string>): ActionRowBuilder<ButtonBuilder> | null {
  const buttons = embedConfig.buttons.slice(0, 5).filter((b) => b.label.trim() && b.url.trim());
  if (!buttons.length) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...buttons.map((b) =>
      new ButtonBuilder().setLabel(b.label.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(interpolateTokens(b.url, tokens)),
    ),
  );
}

function buildContent(watcher: NotifiableWatcher, tokens: Record<string, string>): string {
  const rendered = interpolateTokens(watcher.messageContent, tokens);
  const roleMentions = watcher.mentionRoleIds.map((id) => `<@&${id}>`).join(" ");

  if (!roleMentions) return rendered.slice(0, 2000);
  if (rendered.includes("{roles}")) return rendered.replace(/\{roles\}/g, roleMentions).slice(0, 2000);
  return rendered ? `${roleMentions} ${rendered}`.slice(0, 2000) : roleMentions.slice(0, 2000);
}

export function buildNotificationPayload(
  watcher: NotifiableWatcher,
  tokens: Record<string, string>,
  /** Which token holds the source's avatar image, and which holds the post/stream media thumbnail — used to resolve "channel"/"video" icon sources. */
  avatarKey: string,
  mediaKey: string,
): BaseMessageOptions {
  const embed = buildEmbed(watcher.embedConfig, tokens, avatarKey, mediaKey);
  const buttonsRow = buildButtonsRow(watcher.embedConfig, tokens);
  const content = buildContent(watcher, tokens);

  return {
    content: content || undefined,
    embeds: embed ? [embed] : [],
    components: buttonsRow ? [buttonsRow] : [],
    allowedMentions: { roles: watcher.mentionRoleIds, parse: [] },
  };
}

/** Send a notification for a watcher. Never throws; logs and returns false on failure. */
export async function sendNotification(
  client: Client,
  watcher: NotifiableWatcher,
  tokens: Record<string, string>,
  avatarKey: string,
  mediaKey: string,
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(watcher.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      log.warn(`[social] watcher ${watcher.id}: target channel ${watcher.discordChannelId} is unavailable.`);
      return false;
    }
    await channel.send(buildNotificationPayload(watcher, tokens, avatarKey, mediaKey));
    return true;
  } catch (error) {
    log.error(`[social] watcher ${watcher.id}: failed to send notification:`, error);
    return false;
  }
}
