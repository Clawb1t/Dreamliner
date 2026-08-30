import {
  ActionRowBuilder,
  ButtonBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type MessageCreateOptions,
  type WebhookMessageCreateOptions,
} from "discord.js";
import { extractMessageLinks, type ParsedMessageLink } from "../../../core/messageLink.js";
import { getExpandMessageWebhook } from "./expandWebhook.js";
import { buildExpandDeleteButton } from "./expandDeleteButton.js";

const CONTENT_MAX = 1800;
const MAX_FILES = 10;

function buildExpandContent(source: Message): string {
  const parts: string[] = [];
  const body = source.content?.trim() ?? "";
  if (body) parts.push(body.slice(0, CONTENT_MAX));

  if (source.stickers.size > 0) {
    const stickerNames = [...source.stickers.values()].map((s) => s.name).join(", ");
    parts.push(`_Sticker${source.stickers.size === 1 ? "" : "s"}: ${stickerNames}_`);
  }

  return parts.join("\n");
}

function buildExpandActionsRow(requesterId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buildExpandDeleteButton(requesterId));
}

function buildExpandFiles(source: Message) {
  return [...source.attachments.values()].slice(0, MAX_FILES).map((attachment) => ({
    attachment: attachment.url,
    name: attachment.name || `file-${attachment.id}`,
  }));
}

function authorName(source: Message): string {
  const display =
    source.member?.displayName || source.author.displayName || source.author.username;
  return display.slice(0, 80);
}

function buildWebhookPayload(source: Message, requesterId: string): WebhookMessageCreateOptions {
  const files = buildExpandFiles(source);
  return {
    username: authorName(source),
    avatarURL: source.author.displayAvatarURL({ size: 256, extension: "png" }),
    content: buildExpandContent(source),
    embeds: source.embeds.length ? source.embeds.slice(0, 10).map((e) => e.toJSON()) : undefined,
    files: files.length ? files : undefined,
    components: [buildExpandActionsRow(requesterId)],
    flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [] },
  };
}

function buildFallbackPayload(source: Message, requesterId: string): MessageCreateOptions {
  const files = buildExpandFiles(source);
  const name = authorName(source);
  return {
    content: `**${name}**\n${buildExpandContent(source)}`,
    embeds: source.embeds.length ? source.embeds.slice(0, 10).map((e) => e.toJSON()) : undefined,
    files: files.length ? files : undefined,
    components: [buildExpandActionsRow(requesterId)],
    flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** Poster must be a member of the linked guild with access to the linked channel. */
async function posterCanViewChannel(
  guild: Guild,
  channel: GuildBasedChannel,
  posterId: string,
): Promise<boolean> {
  const member =
    guild.members.cache.get(posterId) ?? (await guild.members.fetch(posterId).catch(() => null));
  if (!member) return false;

  const perms = channel.permissionsFor(member);
  if (!perms) return false;
  return perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.ReadMessageHistory);
}

async function fetchLinkedMessage(
  client: Client,
  link: ParsedMessageLink,
  posterId: string,
): Promise<Message | null> {
  const guild = client.guilds.cache.get(link.guildId) ?? (await client.guilds.fetch(link.guildId).catch(() => null));
  if (!guild) return null;

  const channel =
    guild.channels.cache.get(link.channelId) ??
    (await guild.channels.fetch(link.channelId).catch(() => null));
  if (!channel || !channel.isTextBased() || !("messages" in channel)) return null;

  if (!(await posterCanViewChannel(guild, channel, posterId))) return null;

  return channel.messages.fetch(link.messageId).catch(() => null);
}

/** When a member pastes a Discord message link, mirror that message via webhook. */
export async function handleExpandMessageLinks(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || message.webhookId) return;
  if (!message.content) return;

  const links = extractMessageLinks(message.content);
  if (links.length === 0) return;

  const channel = message.channel;
  if (!channel.isTextBased() || channel.isDMBased()) return;

  // Expand the first link only to avoid spam.
  const link = links[0]!;
  const source = await fetchLinkedMessage(message.client, link, message.author.id);
  if (!source) return;

  // Nothing useful to show.
  if (!source.content?.trim() && source.attachments.size === 0 && source.embeds.length === 0 && source.stickers.size === 0) {
    return;
  }

  const webhook = await getExpandMessageWebhook(channel);
  if (webhook) {
    await webhook.send(buildWebhookPayload(source, message.author.id)).catch(() => null);
    return;
  }

  await channel.send(buildFallbackPayload(source, message.author.id)).catch(() => null);
}
