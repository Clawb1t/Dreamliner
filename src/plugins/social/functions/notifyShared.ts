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
  MessageFlags,
  type Client,
  type BaseMessageOptions,
  type Message,
} from "discord.js";
import type { SocialEmbedConfig } from "../../../config/schemas/social.js";
import { getLogger } from "../../../core/logger.js";
import { fetchGuildChannel } from "../../../core/guildChannel.js";
const log = getLogger("social");

export type NotifiableWatcher = {
  id: number;
  guildId: string;
  discordChannelId: string;
  messageContent: string;
  mentionRoleIds: string[];
  embedConfig: SocialEmbedConfig;
};

/** Per-send tweaks: a type-specific message/roles, and quiet hours / cooldown (no pings, silent). */
export type SendTweaks = {
  messageContent?: string;
  mentionRoleIds?: string[];
  /** Post without pinging roles and with Discord's silent flag. */
  silent?: boolean;
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
  timestamp?: Date,
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
  if (embedConfig.timestamp) {
    embed.setTimestamp(timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : new Date());
  }

  for (const field of embedConfig.fields.slice(0, 25)) {
    const name = interpolateTokens(field.name, tokens).slice(0, 256).trim();
    const value = interpolateTokens(field.value, tokens).slice(0, 1024).trim();
    if (!name || !value) continue;
    embed.addFields({ name, value, inline: field.inline });
  }

  return embed;
}

function buildButtonsRow(embedConfig: SocialEmbedConfig, tokens: Record<string, string>): ActionRowBuilder<ButtonBuilder> | null {
  // Buttons are edited as part of the embed on the dashboard, so they're only sent alongside it.
  if (!embedConfig.enabled) return null;
  const buttons = embedConfig.buttons.slice(0, 5).filter((b) => b.label.trim() && b.url.trim());
  if (!buttons.length) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...buttons.map((b) =>
      new ButtonBuilder().setLabel(b.label.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(interpolateTokens(b.url, tokens)),
    ),
  );
}

function buildContent(messageContent: string, mentionRoleIds: string[], tokens: Record<string, string>): string {
  const rendered = interpolateTokens(messageContent, tokens);
  const roleMentions = mentionRoleIds.map((id) => `<@&${id}>`).join(" ");

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
  /** The video's publish time / stream's start time, used for the embed timestamp (falls back to now). */
  timestamp?: Date,
  tweaks: SendTweaks = {},
): BaseMessageOptions & { flags?: MessageFlags.SuppressNotifications } {
  const embed = buildEmbed(watcher.embedConfig, tokens, avatarKey, mediaKey, timestamp);
  const buttonsRow = buildButtonsRow(watcher.embedConfig, tokens);
  const roles = tweaks.mentionRoleIds ?? watcher.mentionRoleIds;
  // Silent sends still show which roles it's for, as plain text with no ping.
  const content = buildContent(tweaks.messageContent ?? watcher.messageContent, roles, tokens);

  return {
    content: content || undefined,
    embeds: embed ? [embed] : [],
    components: buttonsRow ? [buttonsRow] : [],
    allowedMentions: { roles: tweaks.silent ? [] : roles, parse: [] },
    ...(tweaks.silent ? { flags: MessageFlags.SuppressNotifications as const } : {}),
  };
}

/** Send a notification for a watcher. Never throws; logs and returns null on failure. */
export async function sendNotification(
  client: Client,
  watcher: NotifiableWatcher,
  tokens: Record<string, string>,
  avatarKey: string,
  mediaKey: string,
  timestamp?: Date,
  tweaks: SendTweaks = {},
): Promise<Message | null> {
  try {
    // Only the watcher's own server: a channel id from another server is treated as unavailable.
    const channel = await fetchGuildChannel(client, watcher.guildId, watcher.discordChannelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      log.warn(`[social] watcher ${watcher.id}: target channel ${watcher.discordChannelId} is unavailable.`);
      return null;
    }
    return await channel.send(buildNotificationPayload(watcher, tokens, avatarKey, mediaKey, timestamp, tweaks));
  } catch (error) {
    log.error(`[social] watcher ${watcher.id}: failed to send notification:`, error);
    return null;
  }
}

/** Edit a message the bot posted for a watcher. Never throws; false when it's gone or not editable. */
export async function editNotification(
  client: Client,
  guildId: string,
  channelId: string,
  messageId: string,
  payload: BaseMessageOptions,
): Promise<boolean> {
  try {
    const channel = await fetchGuildChannel(client, guildId, channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return false;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message || !message.editable) return false;
    // Edits never re-ping, so no mentions are allowed through.
    await message.edit({ ...payload, allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    log.warn(`[social] couldn't edit message ${messageId}:`, error);
    return false;
  }
}

/** Delete a message the bot posted for a watcher. Never throws. */
export async function deleteNotification(client: Client, guildId: string, channelId: string, messageId: string): Promise<boolean> {
  try {
    const channel = await fetchGuildChannel(client, guildId, channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return false;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return false;
    await message.delete();
    return true;
  } catch (error) {
    log.warn(`[social] couldn't delete message ${messageId}:`, error);
    return false;
  }
}

/** Post a follow-up in a watcher's channel, as a reply to `replyTo` when it still exists. */
export async function sendFollowUp(
  client: Client,
  guildId: string,
  channelId: string,
  payload: BaseMessageOptions,
  replyTo?: string | null,
): Promise<Message | null> {
  try {
    const channel = await fetchGuildChannel(client, guildId, channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    return await channel.send({
      ...payload,
      allowedMentions: { parse: [] },
      ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
    });
  } catch (error) {
    log.warn(`[social] couldn't post a follow-up in ${channelId}:`, error);
    return null;
  }
}
