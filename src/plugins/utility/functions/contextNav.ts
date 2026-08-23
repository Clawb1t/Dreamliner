import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { DREAMLINER_ACCENT } from "../../../core/embeds.js";
import { guildResultOptions, resultReply } from "../../../core/responses.js";

export const CONTEXT_NAV_PREFIX = "utility:context:nav:";

const MAX_OFFSET = 5;

const CUSTOM_ID_RE = /^utility:context:nav:(\d{17,20}):(\d{17,20}):(-?\d{1,2}):(\d{17,20})$/;

export function buildContextNavCustomId(
  channelId: string,
  anchorId: string,
  offset: number,
  invokerId: string,
): string {
  return `${CONTEXT_NAV_PREFIX}${channelId}:${anchorId}:${offset}:${invokerId}`;
}

export function parseContextNavCustomId(customId: string): {
  channelId: string;
  anchorId: string;
  offset: number;
  invokerId: string;
} | null {
  const match = CUSTOM_ID_RE.exec(customId);
  if (!match) return null;
  const [, channelId, anchorId, offsetRaw, invokerId] = match;
  const offset = Number(offsetRaw);
  if (!Number.isFinite(offset) || offset < -MAX_OFFSET || offset > MAX_OFFSET) return null;
  return { channelId: channelId!, anchorId: anchorId!, offset, invokerId: invokerId! };
}

/** Fetch the message `offset` positions away from `anchorId` (negative = older, positive = newer). */
export async function fetchMessageAtOffset(
  channel: GuildTextBasedChannel,
  anchorId: string,
  offset: number,
): Promise<Message | null> {
  if (offset === 0) {
    return channel.messages.fetch(anchorId).catch(() => null);
  }

  const count = Math.abs(offset);
  const batch = await (offset < 0
    ? channel.messages.fetch({ before: anchorId, limit: count })
    : channel.messages.fetch({ after: anchorId, limit: count })
  ).catch(() => null);
  if (!batch || batch.size < count) return null;

  const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return offset < 0 ? sorted[0]! : sorted[sorted.length - 1]!;
}

function offsetLabel(offset: number): string {
  if (offset === 0) return "Target message";
  const count = Math.abs(offset);
  const noun = count === 1 ? "message" : "messages";
  return offset < 0 ? `${count} ${noun} before target` : `${count} ${noun} after target`;
}

/** Top embed: blurple, author = message author, description = the message's content. */
export function buildContextMessageEmbed(message: Message): EmbedBuilder {
  const content = message.content.trim();
  return new EmbedBuilder()
    .setColor(DREAMLINER_ACCENT)
    .setAuthor({
      name: message.author.tag,
      iconURL: message.author.displayAvatarURL({ size: 128 }),
    })
    .setDescription(content.length > 0 ? content.slice(0, 4096) : "*(no text content)*")
    .setTimestamp(message.createdAt);
}

/** Bottom embed: blurple, shows where in the navigation window we are and a jump link. */
export function buildContextNavEmbed(message: Message, offset: number): EmbedBuilder {
  const link = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  return new EmbedBuilder()
    .setColor(DREAMLINER_ACCENT)
    .setDescription(`${offsetLabel(offset)} • [Jump to message ➔](${link})`);
}

export function buildContextNavRow(
  channelId: string,
  anchorId: string,
  offset: number,
  invokerId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildContextNavCustomId(channelId, anchorId, Math.max(offset - 1, -MAX_OFFSET), invokerId))
      .setLabel("Up")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(offset <= -MAX_OFFSET),
    new ButtonBuilder()
      .setCustomId(buildContextNavCustomId(channelId, anchorId, Math.min(offset + 1, MAX_OFFSET), invokerId))
      .setLabel("Down")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(offset >= MAX_OFFSET),
  );
}

export function buildContextNavPayload(
  message: Message,
  channelId: string,
  anchorId: string,
  offset: number,
  invokerId: string,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  return {
    embeds: [buildContextMessageEmbed(message), buildContextNavEmbed(message, offset)],
    components: [buildContextNavRow(channelId, anchorId, offset, invokerId)],
  };
}

export async function handleContextNavButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(CONTEXT_NAV_PREFIX)) return false;

  const parsed = parseContextNavCustomId(interaction.customId);
  if (!parsed) return true;

  if (!interaction.inGuild() || !interaction.guildId) return true;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  const options = guildResultOptions(interaction.client, guildConfig, { tone: "error" });

  if (interaction.user.id !== parsed.invokerId) {
    await interaction.reply(
      resultReply("Not your context", "Only the person who ran /context can use these buttons.", true, options),
    );
    return true;
  }

  const channel = await interaction.client.channels.fetch(parsed.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.reply(resultReply("Channel unavailable", "That channel is no longer available.", true, options));
    return true;
  }

  const message = await fetchMessageAtOffset(
    channel as GuildTextBasedChannel,
    parsed.anchorId,
    parsed.offset,
  );
  if (!message) {
    await interaction.reply(
      resultReply("No message found", "There is no message that far in that direction.", true, options),
    );
    return true;
  }

  const payload = buildContextNavPayload(
    message,
    parsed.channelId,
    parsed.anchorId,
    parsed.offset,
    parsed.invokerId,
  );

  await interaction.update(payload).catch(async () => {
    await interaction
      .reply(resultReply("Could not update", "That message may have been deleted.", true, options))
      .catch(() => null);
  });

  return true;
}
