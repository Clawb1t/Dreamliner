import { PermissionFlagsBits, type Channel, type Client, type Message } from "discord.js";
import { configManager } from "../../../config/manager.js";
import {
  ensureScamProtectChannel,
  ensureScamProtectForClient,
  getScamProtectConfig,
  isScamProtectEnabled,
} from "./ensure.js";
import { softbanForScamProtect } from "./softban.js";

const inFlight = new Set<string>();

export async function handleScamProtectMessage(message: Message): Promise<void> {
  if (!message.guild || message.webhookId) return;
  if (message.author.id === message.client.user?.id) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!isScamProtectEnabled(guildConfig)) return;

  const config = getScamProtectConfig(guildConfig);
  if (!config.channel_id || message.channelId !== config.channel_id) return;
  if (config.warning_message_id && message.id === config.warning_message_id) return;

  if (message.member) {
    if (message.guild.ownerId === message.author.id) return;
    if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    if (message.member.permissions.has(PermissionFlagsBits.BanMembers)) return;
    if (config.ignored_roles.some((id) => message.member!.roles.cache.has(id))) return;
  }

  const key = `${message.guild.id}:${message.author.id}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  try {
    const result = await softbanForScamProtect({
      client: message.client,
      guild: message.guild,
      guildConfig,
      user: message.author,
    });
    if (result.ok) {
      const { refreshScamProtectWarning } = await import("./ensure.js");
      await refreshScamProtectWarning(message.guild).catch(() => null);
    }
  } finally {
    inFlight.delete(key);
  }
}

export async function handleScamProtectReady(client: Client): Promise<void> {
  await ensureScamProtectForClient(client);
}

export async function handleScamProtectChannelDelete(channel: Channel): Promise<void> {
  if (!("guild" in channel) || !channel.guild) return;
  const guild = channel.guild;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!isScamProtectEnabled(guildConfig)) return;

  const config = getScamProtectConfig(guildConfig);
  if (!config.channel_id || channel.id !== config.channel_id) return;

  await configManager.patchPluginConfig(
    guild.id,
    "scam_protect",
    { channel_id: null, warning_message_id: null },
    "system:scam_protect",
  );

  setTimeout(() => {
    void ensureScamProtectChannel(guild).catch(() => null);
  }, 1500);
}
