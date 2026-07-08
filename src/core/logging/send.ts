import type { Client, TextChannel } from "discord.js";
import type { GuildConfig } from "../../config/schemas/guild.js";
import { getModerationLogChannelId, getServerLogChannelId } from "./channels.js";
import { buildLogPayload } from "./container.js";
import type { LogCard } from "./types.js";

async function sendToChannel(client: Client, channelId: string, card: LogCard): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  await (channel as TextChannel).send(buildLogPayload(card)).catch(() => null);
}

export async function sendModerationLog(
  client: Client,
  guildConfig: GuildConfig,
  card: LogCard,
  options?: { caseLogOverride?: string | null },
): Promise<void> {
  const channelId = getModerationLogChannelId(guildConfig, options?.caseLogOverride);
  if (!channelId) return;
  await sendToChannel(client, channelId, card);
}

export async function sendServerLog(client: Client, guildConfig: GuildConfig, card: LogCard): Promise<void> {
  const channelId = getServerLogChannelId(guildConfig);
  if (!channelId) return;
  await sendToChannel(client, channelId, card);
}
