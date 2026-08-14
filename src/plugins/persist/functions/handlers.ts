import type {
  Client,
  GuildTextBasedChannel,
  Message,
  PartialMessage,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { PersistSticky } from "../../../config/schemas/persist.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { loadPersistConfig, stickyByChannel } from "./config.js";
import {
  buildPersistPayload,
  persistMessageFingerprint,
  persistPayloadFingerprint,
  type PersistBuildContext,
} from "./messageBuilder.js";
import {
  deletePersistWebhookMessage,
  getPersistWebhook,
  isPersistWebhook,
  rememberPersistWebhook,
} from "./webhook.js";
import {
  getPersistedMessage,
  listPersistedMessages,
  removePersistedMessage,
  upsertPersistedMessage,
} from "./store.js";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const bumpChains = new Map<string, Promise<unknown>>();
const knownStickyIds = new Set<string>();
const bumpingChannels = new Set<string>();

function channelKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function runExclusive(key: string, task: () => Promise<void>): Promise<void> {
  const previous = bumpChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  bumpChains.set(key, settled);
  void settled.then(() => {
    if (bumpChains.get(key) === settled) bumpChains.delete(key);
  });
  return current;
}

function asSendChannel(channel: Message["channel"] | PartialMessage["channel"]): GuildTextBasedChannel | null {
  if (!channel.isTextBased() || channel.isDMBased() || !("send" in channel) || !("messages" in channel)) {
    return null;
  }
  return channel as GuildTextBasedChannel;
}

function isOwnSticky(message: Message | PartialMessage, trackedId?: string): boolean {
  if (trackedId && message.id === trackedId) return true;
  if (knownStickyIds.has(message.id)) return true;
  if (message.author?.id && message.author.id === message.client.user?.id) return true;
  if (isPersistWebhook(message.webhookId)) return true;
  return false;
}

function shouldIgnoreTrigger(message: Message, sticky: PersistSticky): boolean {
  if (message.webhookId && sticky.ignore_webhooks) return true;
  if (message.author.bot && sticky.ignore_bots) return true;
  return false;
}

function buildContext(channel: GuildTextBasedChannel): PersistBuildContext {
  return {
    client: channel.client,
    guild: channel.guild,
    channel,
  };
}

async function deleteTrackedMessage(
  channel: GuildTextBasedChannel,
  messageId: string | undefined,
  webhookId?: string | null,
): Promise<void> {
  if (!messageId) return;
  knownStickyIds.delete(messageId);
  await deletePersistWebhookMessage(channel, messageId, webhookId);
}

async function postSticky(
  channel: GuildTextBasedChannel,
  guildId: string,
  sticky: PersistSticky,
  previous?: { messageId?: string; webhookId?: string | null },
): Promise<void> {
  const key = channelKey(guildId, channel.id);
  bumpingChannels.add(key);
  try {
    const built = buildPersistPayload(sticky, buildContext(channel));
    if (built.empty) return;

    let sent: Message | null = null;
    if (sticky.webhook) {
      const hook = await getPersistWebhook(channel);
      if (hook) {
        rememberPersistWebhook(hook.id);
        sent = (await hook.send(built.webhookPayload).catch(() => null)) as Message | null;
      }
    }
    if (!sent) {
      sent = await channel.send(built.payload).catch(() => null);
    }
    if (!sent) return;

    knownStickyIds.add(sent.id);
    await upsertPersistedMessage({
      guildId,
      channelId: channel.id,
      messageId: sent.id,
    });

    if (previous?.messageId && previous.messageId !== sent.id) {
      await deleteTrackedMessage(channel, previous.messageId, previous.webhookId);
    }
  } finally {
    bumpingChannels.delete(key);
  }
}

async function bumpSticky(client: Client, guildId: string, channelId: string): Promise<void> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "persist")) return;

  const sticky = stickyByChannel(loadPersistConfig(guildConfig)).get(channelId);
  const tracked = await getPersistedMessage(guildId, channelId);

  if (!sticky) {
    if (tracked) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      const channel = await guild?.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased() && "send" in channel) {
        await deleteTrackedMessage(channel as GuildTextBasedChannel, tracked.messageId);
      }
      await removePersistedMessage(guildId, channelId);
    }
    return;
  }

  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;
  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  if (!fetched?.isTextBased() || fetched.isDMBased() || !("send" in fetched)) return;
  const channel = fetched as GuildTextBasedChannel;

  const latest = await channel.messages.fetch({ limit: 1 }).catch(() => null);
  const last = latest?.first();
  if (last && last.id === tracked?.messageId) {
    knownStickyIds.add(last.id);
    const built = buildPersistPayload(sticky, buildContext(channel));
    if (persistMessageFingerprint(last) === persistPayloadFingerprint(built, sticky.webhook && Boolean(last.webhookId))) {
      return;
    }
  }

  await postSticky(channel, guildId, sticky, {
    messageId: tracked?.messageId,
    webhookId: last?.id === tracked?.messageId ? last?.webhookId : undefined,
  });
}

function cancelChannelTimer(guildId: string, channelId: string): void {
  const key = channelKey(guildId, channelId);
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
    timers.delete(key);
  }
}

function scheduleBump(client: Client, guildId: string, channelId: string, delaySeconds: number): void {
  const key = channelKey(guildId, channelId);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);

  const delayMs = Math.max(0, delaySeconds) * 1000;
  const timer = setTimeout(() => {
    timers.delete(key);
    void runExclusive(key, () => bumpSticky(client, guildId, channelId));
  }, delayMs);
  timers.set(key, timer);
}

export async function handlePersistMessageCreate(message: Message): Promise<void> {
  if (!message.guild || message.system) return;
  const channel = asSendChannel(message.channel);
  if (!channel) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "persist")) return;

  const sticky = stickyByChannel(loadPersistConfig(guildConfig)).get(channel.id);
  if (!sticky) return;

  const tracked = await getPersistedMessage(message.guild.id, channel.id);
  if (isOwnSticky(message, tracked?.messageId)) {
    knownStickyIds.add(message.id);
    return;
  }

  if (shouldIgnoreTrigger(message, sticky)) return;

  scheduleBump(message.client, message.guild.id, channel.id, sticky.delay_seconds);
}

export async function handlePersistMessageDelete(message: Message | PartialMessage): Promise<void> {
  if (!message.guild) return;
  const key = channelKey(message.guild.id, message.channel.id);
  if (bumpingChannels.has(key)) return;

  const tracked = await getPersistedMessage(message.guild.id, message.channel.id);
  if (!tracked || tracked.messageId !== message.id) return;

  knownStickyIds.delete(message.id);

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "persist")) return;

  const sticky = stickyByChannel(loadPersistConfig(guildConfig)).get(message.channel.id);
  if (!sticky) {
    await removePersistedMessage(message.guild.id, message.channel.id);
    return;
  }

  void runExclusive(key, () => bumpSticky(message.client, message.guild!.id, message.channel.id));
}

export async function handlePersistMessageBulkDelete(
  messages: ReadonlyMap<string, Message<boolean> | PartialMessage>,
  channel: Message["channel"],
): Promise<void> {
  if (!("guild" in channel) || !channel.guild) return;
  const tracked = await getPersistedMessage(channel.guild.id, channel.id);
  if (!tracked) return;
  const deleted = messages.get(tracked.messageId);
  if (!deleted) return;
  await handlePersistMessageDelete(deleted);
}

export async function handlePersistChannelDelete(channel: {
  id: string;
  guild?: { id: string } | null;
}): Promise<void> {
  const guildId = channel.guild?.id;
  if (!guildId) return;
  cancelChannelTimer(guildId, channel.id);
  const tracked = await getPersistedMessage(guildId, channel.id);
  if (tracked) knownStickyIds.delete(tracked.messageId);
  await removePersistedMessage(guildId, channel.id);
}

export async function syncGuildStickies(
  client: Client,
  guildId: string,
  options?: { updateContent?: boolean; guildConfig?: GuildConfig },
): Promise<void> {
  const guildConfig = options?.guildConfig ?? (await configManager.getEffectiveConfig(guildId));
  const trackedRows = await listPersistedMessages(guildId);

  if (!pluginEnabled(guildConfig, "persist")) {
    for (const key of [...timers.keys()]) {
      if (key.startsWith(`${guildId}:`)) {
        const timer = timers.get(key);
        if (timer) clearTimeout(timer);
        timers.delete(key);
      }
    }
    return;
  }

  const stickies = stickyByChannel(loadPersistConfig(guildConfig));
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  for (const row of trackedRows) {
    if (stickies.has(row.channelId)) continue;
    cancelChannelTimer(guildId, row.channelId);
    const channel = await guild.channels.fetch(row.channelId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      await deleteTrackedMessage(channel as GuildTextBasedChannel, row.messageId);
    }
    await removePersistedMessage(guildId, row.channelId);
  }

  for (const [channelId, sticky] of stickies) {
    const key = channelKey(guildId, channelId);
    await runExclusive(key, async () => {
      const channelRef = await guild.channels.fetch(channelId).catch(() => null);
      if (!channelRef?.isTextBased() || channelRef.isDMBased() || !("send" in channelRef)) return;
      const channel = channelRef as GuildTextBasedChannel;
      const tracked = await getPersistedMessage(guildId, channelId);

      if (!tracked) {
        await postSticky(channel, guildId, sticky);
        return;
      }

      const existing = await channel.messages.fetch(tracked.messageId).catch(() => null);
      if (!existing) {
        await postSticky(channel, guildId, sticky);
        return;
      }

      knownStickyIds.add(existing.id);
      if (existing.webhookId) rememberPersistWebhook(existing.webhookId);
      if (!options?.updateContent) return;

      const built = buildPersistPayload(sticky, buildContext(channel));
      if (persistMessageFingerprint(existing) === persistPayloadFingerprint(built, sticky.webhook && Boolean(existing.webhookId))) {
        return;
      }
      await postSticky(channel, guildId, sticky, {
        messageId: existing.id,
        webhookId: existing.webhookId,
      });
    });
  }
}

export async function handlePersistReady(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await syncGuildStickies(client, guild.id).catch((error) => {
      console.error(`[persist] Failed to sync stickies for ${guild.id}:`, error);
    });
  }
}
