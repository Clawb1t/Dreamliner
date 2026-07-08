import type { Message, PartialMessage, TextChannel } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getPersistedMessage, updatePersistedMessageId } from "./store.js";

export async function handlePersistMessageDelete(message: Message | PartialMessage): Promise<void> {
  if (!message.guild) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "persist")) return;

  const channelId = message.channel.id;
  const persisted = await getPersistedMessage(message.guild.id, channelId);
  if (!persisted) return;
  if (persisted.messageId !== message.id) return;

  const channel = message.channel;
  if (!channel.isTextBased() || channel.isDMBased() || !("send" in channel)) return;

  const sent = await (channel as TextChannel).send(persisted.content).catch(() => null);
  if (!sent) return;

  await updatePersistedMessageId(message.guild.id, channelId, sent.id);
}
