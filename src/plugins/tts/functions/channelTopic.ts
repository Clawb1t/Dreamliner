import { ChannelType, type Client } from "discord.js";
import { getAccountVoiceUrl } from "../../../core/docsUrl.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";

function desiredTopic(): string {
  return (
    `Messages sent here are spoken aloud in the voice channel you're in, using Dreamliner ` +
    `text-to-speech. Change your voice: ${getAccountVoiceUrl()}`
  );
}

/**
 * Keeps the configured TTS text channel's topic explaining what it does, so someone opening
 * it cold understands why typing there talks in a voice channel. Runs on every config save
 * (matching the pattern other plugins use to react to dashboard/command changes) and is a
 * no-op once the topic already matches.
 */
export async function syncTtsChannelTopic(client: Client, guildId: string, config: GuildConfig): Promise<void> {
  const textChannelId = config.plugins.tts?.config?.text_channel_id?.trim();
  if (!textChannelId) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const channel = await guild.channels.fetch(textChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const topic = desiredTopic();
  if (channel.topic === topic) return;

  await channel.setTopic(topic, "Dreamliner TTS channel").catch(() => null);
}
