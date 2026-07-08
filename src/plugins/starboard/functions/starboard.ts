import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type GuildTextBasedChannel,
  type Message,
  type MessageReaction,
  type User,
} from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { StarboardBoard, StarboardConfig } from "../../../config/schemas/starboard.js";
import { configManager } from "../../../config/manager.js";
import { getStarboardPluginConfig } from "../../../core/guildHelpers.js";
import {
  createStarboardPost,
  deleteStarboardPost,
  deleteStarboardPostsForSourceMessage,
  getStarboardPost,
  updateStarboardPostStarCount,
} from "./store.js";

const processingLocks = new Map<string, Promise<void>>();

function lockKey(guildId: string, boardName: string, messageId: string): string {
  return `${guildId}:${boardName}:${messageId}`;
}

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = processingLocks.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(fn)
    .finally(() => {
      if (processingLocks.get(key) === next) {
        processingLocks.delete(key);
      }
    }) as Promise<T>;
  processingLocks.set(key, next as Promise<void>);
  return next;
}

function emojiMatches(reactionEmoji: MessageReaction["emoji"], configured: string[]): boolean {
  const id = reactionEmoji.id;
  const name = reactionEmoji.name ?? "";
  const reactionString = reactionEmoji.toString();

  for (const configuredEmoji of configured) {
    if (configuredEmoji === reactionString) return true;
    if (!id && configuredEmoji === name) return true;

    const customMatch = configuredEmoji.match(/^<a?:([^:]+):(\d+)>$/);
    if (customMatch && id === customMatch[2]) return true;
  }

  return false;
}

function shouldCountStarFromUser(message: Message, user: User, board: StarboardBoard): boolean {
  if (user.bot) return false;
  if (!board.count_self_stars && message.author && user.id === message.author.id) return false;
  return true;
}

export async function countStarReactions(
  message: Message,
  board: StarboardBoard,
  reactionEvent?: { user: User; emoji: MessageReaction["emoji"]; type: "add" | "remove" },
): Promise<number> {
  if (!message.guild) return 0;

  if (!message.author) {
    try {
      await message.fetch();
    } catch {
      return 0;
    }
  }

  try {
    await message.fetch();
  } catch {
    // continue with cached reactions
  }

  const voters = new Set<string>();
  for (const reaction of message.reactions.cache.values()) {
    if (!emojiMatches(reaction.emoji, board.star_emoji)) continue;

    let users;
    try {
      users = await reaction.users.fetch();
    } catch {
      continue;
    }

    for (const user of users.values()) {
      if (!shouldCountStarFromUser(message, user, board)) continue;
      voters.add(user.id);
    }
  }

  if (reactionEvent && emojiMatches(reactionEvent.emoji, board.star_emoji)) {
    const { user, type } = reactionEvent;
    if (shouldCountStarFromUser(message, user, board)) {
      if (type === "add") voters.add(user.id);
      else voters.delete(user.id);
    }
  }

  return voters.size;
}

function starDisplayEmoji(board: StarboardBoard): string {
  const first = board.star_emoji[0] ?? "⭐";
  return first;
}

function parseCustomEmoji(configured: string): { id: string; name: string; animated?: boolean } | null {
  const match = configured.match(/^<(a)?:(\w+):(\d+)>$/);
  if (!match) return null;
  return { animated: Boolean(match[1]), name: match[2], id: match[3] };
}

function channelFooterName(message: Message): string {
  if (message.channel.isTextBased() && "name" in message.channel && message.channel.name) {
    return message.channel.name;
  }
  return "unknown channel";
}

function buildStarboardEmbed(message: Message, board: StarboardBoard): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (board.color !== undefined) embed.setColor(board.color);

  const author = message.author;
  if (author) {
    embed.setAuthor({ name: author.displayName, iconURL: author.displayAvatarURL({ size: 128 }) });
  }

  const content = message.content?.trim();
  if (content) {
    embed.setDescription(content.slice(0, 4096));
  }

  const imageAttachment = message.attachments.find((attachment) => {
    const type = attachment.contentType ?? "";
    return type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name ?? "");
  });
  if (imageAttachment) {
    embed.setImage(imageAttachment.url);
  }

  if (board.copy_full_embed) {
    const sourceEmbed = message.embeds[0];
    if (sourceEmbed) {
      if (!embed.data.description && sourceEmbed.description) {
        embed.setDescription(sourceEmbed.description.slice(0, 4096));
      }
      if (sourceEmbed.title) embed.setTitle(sourceEmbed.title.slice(0, 256));
      if (!embed.data.image?.url && sourceEmbed.image?.url) embed.setImage(sourceEmbed.image.url);
      if (sourceEmbed.thumbnail?.url) embed.setThumbnail(sourceEmbed.thumbnail.url);
      if (sourceEmbed.url) embed.setURL(sourceEmbed.url);
      for (const field of sourceEmbed.fields.slice(0, 25)) {
        embed.addFields({ name: field.name.slice(0, 256), value: field.value.slice(0, 1024), inline: field.inline });
      }
    }
  }

  embed.setFooter({ text: channelFooterName(message) });
  embed.setTimestamp(message.createdAt);

  if (!embed.data.description && !embed.data.image?.url && !embed.data.title) {
    embed.setDescription("(no text content)");
  }

  return embed;
}

function buildStarboardComponents(starCount: number, board: StarboardBoard, messageUrl: string): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (board.show_star_count) {
    const starButton = new ButtonBuilder()
      .setCustomId("dl:starboard:count")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    const customEmoji = parseCustomEmoji(starDisplayEmoji(board));
    if (customEmoji) {
      starButton.setEmoji({ id: customEmoji.id, name: customEmoji.name, animated: customEmoji.animated });
      starButton.setLabel(String(starCount));
    } else {
      starButton.setLabel(`${starDisplayEmoji(board)} ${starCount}`);
    }

    row.addComponents(starButton);
  }

  row.addComponents(
    new ButtonBuilder().setLabel("Jump to message").setStyle(ButtonStyle.Link).setURL(messageUrl),
  );

  return row;
}

function buildStarboardPayload(message: Message, starCount: number, board: StarboardBoard) {
  return {
    embeds: [buildStarboardEmbed(message, board)],
    components: [buildStarboardComponents(starCount, board, message.url)],
  };
}

async function fetchTextChannel(client: Client, channelId: string): Promise<GuildTextBasedChannel | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return null;
  return channel as GuildTextBasedChannel;
}

async function processBoard(
  client: Client,
  message: Message,
  boardName: string,
  board: StarboardBoard,
  starboardChannelIds: Set<string>,
  reactionEvent?: { user: User; emoji: MessageReaction["emoji"]; type: "add" | "remove" },
): Promise<void> {
  if (!message.guild || !board.enabled || !board.channel_id) return;
  if (starboardChannelIds.has(message.channel.id)) return;
  if (message.author?.bot) return;

  const key = lockKey(message.guild.id, boardName, message.id);
  await withLock(key, async () => {
    const starCount = await countStarReactions(message, board, reactionEvent);
    const existing = await getStarboardPost(message.guild!.id, boardName, message.id);
    const meetsThreshold = starCount >= board.stars_required;

    if (!meetsThreshold) {
      if (!existing) return;
      const starboardChannel = await fetchTextChannel(client, board.channel_id);
      if (starboardChannel) {
        const starboardMessage = await starboardChannel.messages.fetch(existing.starboardMessageId).catch(() => null);
        await starboardMessage?.delete().catch(() => null);
      }
      await deleteStarboardPost(message.guild!.id, boardName, message.id);
      return;
    }

    const payload = buildStarboardPayload(message, starCount, board);
    const starboardChannel = await fetchTextChannel(client, board.channel_id);
    if (!starboardChannel) return;

    if (existing) {
      const starboardMessage = await starboardChannel.messages.fetch(existing.starboardMessageId).catch(() => null);
      if (!starboardMessage) {
        await deleteStarboardPost(message.guild!.id, boardName, message.id);
      } else {
        await starboardMessage.edit(payload).catch(async () => {
          await deleteStarboardPost(message.guild!.id, boardName, message.id);
        });
        await updateStarboardPostStarCount(message.guild!.id, boardName, message.id, starCount);
        return;
      }
    }

    const posted = await starboardChannel.send(payload).catch(() => null);
    if (!posted) return;

    await createStarboardPost({
      guildId: message.guild!.id,
      boardName,
      sourceMessageId: message.id,
      sourceChannelId: message.channel.id,
      starboardMessageId: posted.id,
      starCount,
    });
  });
}

export async function processMessageForStarboard(
  client: Client,
  message: Message,
  guildConfig: GuildConfig,
  reactionEvent?: { user: User; emoji: MessageReaction["emoji"]; type: "add" | "remove" },
): Promise<void> {
  const section = guildConfig.plugins.starboard;
  if (section?.enabled === false) return;

  const config = getStarboardPluginConfig(guildConfig) as StarboardConfig;
  const boards = Object.entries(config.boards ?? {});
  if (boards.length === 0) return;

  if (!message.guild) return;

  const ignoredChannelIds = new Set(config.ignored_channels ?? []);
  if (ignoredChannelIds.has(message.channel.id)) return;

  const starboardChannelIds = new Set(
    boards.map(([, board]) => board.channel_id).filter((channelId): channelId is string => Boolean(channelId)),
  );

  for (const [boardName, board] of boards) {
    await processBoard(client, message, boardName, board, starboardChannelIds, reactionEvent);
  }
}

export async function handleStarboardReaction(
  client: Client,
  reaction: MessageReaction,
  user: User,
  type: "add" | "remove",
): Promise<void> {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  let message = reaction.message;
  if (message.partial) {
    try {
      message = await message.fetch();
    } catch {
      return;
    }
  }

  if (message.channel.isTextBased() && message.channel.partial) {
    try {
      await message.channel.fetch();
    } catch {
      return;
    }
  }

  if (!message.guild) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  await processMessageForStarboard(client, message, guildConfig, { user, emoji: reaction.emoji, type });
}

export async function handleStarboardMessageDelete(client: Client, message: Message): Promise<void> {
  if (!message.guild) return;

  const rows = await deleteStarboardPostsForSourceMessage(message.guild.id, message.id);
  if (rows.length === 0) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  const config = getStarboardPluginConfig(guildConfig) as StarboardConfig;

  for (const row of rows) {
    const board = config.boards?.[row.boardName];
    if (!board?.channel_id) continue;

    const starboardChannel = await fetchTextChannel(client, board.channel_id);
    const posted = await starboardChannel?.messages.fetch(row.starboardMessageId).catch(() => null);
    await posted?.delete().catch(() => null);
  }
}
