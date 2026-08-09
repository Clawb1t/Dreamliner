import type { Client, TextChannel } from "discord.js";
import type { GuildConfig } from "../../config/schemas/guild.js";
import { getModerationLogChannelId, getServerLogChannelId } from "./channels.js";
import { buildLogPayload } from "./container.js";
import { LOG_EVENT_META, type LogEventType } from "./events.js";
import { insertGuildLogEvent, setGuildLogDiscordMessageId } from "./store.js";
import { isLogEventEnabled } from "./toggles.js";
import type { LogCard } from "./types.js";

export type LogEmitMeta = {
  guildId: string;
  eventType: LogEventType;
  summary?: string;
  actorId?: string | null;
  targetId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  caseId?: number | null;
  payload?: Record<string, unknown>;
  caseLogOverride?: string | null;
};

async function sendToChannel(
  client: Client,
  channelId: string,
  card: LogCard,
): Promise<string | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return null;
  const sent = await (channel as TextChannel).send(buildLogPayload(card)).catch(() => null);
  return sent?.id ?? null;
}

function summarizeCard(card: LogCard, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim().slice(0, 500);
  const line = card.information.find((item) => item.trim().length > 0);
  return (line ?? card.title).replace(/\s+/g, " ").slice(0, 500);
}

export async function emitLog(
  client: Client,
  guildConfig: GuildConfig,
  card: LogCard,
  meta: LogEmitMeta,
): Promise<string | null> {
  if (!isLogEventEnabled(guildConfig, meta.eventType)) return null;

  const category = LOG_EVENT_META[meta.eventType].category;
  const logId = await insertGuildLogEvent({
    guildId: meta.guildId,
    category,
    eventType: meta.eventType,
    title: card.title,
    summary: summarizeCard(card, meta.summary),
    actorId: meta.actorId,
    targetId: meta.targetId,
    channelId: meta.channelId,
    messageId: meta.messageId,
    caseId: meta.caseId,
    payload: {
      title: card.title,
      information: card.information,
      extra: card.extra ?? null,
      avatarUrl: card.avatarUrl ?? null,
      ...(meta.payload ?? {}),
    },
  });

  const channelId =
    category === "moderation"
      ? getModerationLogChannelId(guildConfig, meta.caseLogOverride)
      : getServerLogChannelId(guildConfig);

  if (channelId) {
    const discordMessageId = await sendToChannel(client, channelId, card);
    if (discordMessageId) {
      await setGuildLogDiscordMessageId(meta.guildId, logId, discordMessageId).catch(() => null);
    }
  }

  return logId;
}

export async function sendModerationLog(
  client: Client,
  guildConfig: GuildConfig,
  card: LogCard,
  meta: LogEmitMeta,
): Promise<void> {
  await emitLog(client, guildConfig, card, meta);
}

export async function sendServerLog(
  client: Client,
  guildConfig: GuildConfig,
  card: LogCard,
  meta: LogEmitMeta,
): Promise<void> {
  await emitLog(client, guildConfig, card, meta);
}
