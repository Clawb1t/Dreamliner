import {
  PermissionFlagsBits,
  type GuildTextBasedChannel,
  type TextChannel,
  type Webhook,
} from "discord.js";

const PERSIST_WEBHOOK_NAME = "Dreamliner Persist";
const AUTOREPLY_WEBHOOK_NAME = "Dreamliner Autoreplies";

const persistWebhookIds = new Set<string>();

function asWebhookChannel(channel: GuildTextBasedChannel): TextChannel | null {
  if (!channel.isTextBased() || channel.isDMBased()) return null;
  if (!("fetchWebhooks" in channel) || typeof channel.fetchWebhooks !== "function") return null;
  if (!("createWebhook" in channel) || typeof channel.createWebhook !== "function") return null;
  return channel as TextChannel;
}

export function isPersistWebhook(webhookId: string | null | undefined): boolean {
  return Boolean(webhookId && persistWebhookIds.has(webhookId));
}

export function rememberPersistWebhook(webhookId: string): void {
  persistWebhookIds.add(webhookId);
}

async function getOwnedWebhook(
  channel: GuildTextBasedChannel,
  name: string,
  reason: string,
  remember?: (id: string) => void,
): Promise<Webhook | null> {
  const textChannel = asWebhookChannel(channel);
  if (!textChannel) return null;

  const me = textChannel.guild.members.me;
  if (!me?.permissionsIn(textChannel).has(PermissionFlagsBits.ManageWebhooks)) {
    return null;
  }

  try {
    const existing = await textChannel.fetchWebhooks();
    const owned = existing.find((hook) => hook.owner?.id === me.id && hook.name === name);
    if (owned) {
      remember?.(owned.id);
      return owned;
    }

    const created = await textChannel.createWebhook({ name, reason });
    remember?.(created.id);
    return created;
  } catch {
    return null;
  }
}

export async function getPersistWebhook(channel: GuildTextBasedChannel): Promise<Webhook | null> {
  return getOwnedWebhook(
    channel,
    PERSIST_WEBHOOK_NAME,
    "Sticky persist messages with custom name and avatar",
    (id) => persistWebhookIds.add(id),
  );
}

export async function getAutoreplyWebhook(channel: GuildTextBasedChannel): Promise<Webhook | null> {
  return getOwnedWebhook(channel, AUTOREPLY_WEBHOOK_NAME, "Auto-reply messages with custom name and avatar");
}

export async function getAutothreadWebhook(channel: GuildTextBasedChannel): Promise<Webhook | null> {
  return getOwnedWebhook(
    channel,
    "Dreamliner Autothreads",
    "Auto-thread messages with custom name and avatar",
  );
}

export async function deletePersistWebhookMessage(
  channel: GuildTextBasedChannel,
  messageId: string,
  webhookId?: string | null,
): Promise<void> {
  if (webhookId) {
    const hook = await getPersistWebhook(channel);
    if (hook) {
      const deleted = await hook.deleteMessage(messageId).then(() => true).catch(() => false);
      if (deleted) return;
    }
  }
  await channel.messages.delete(messageId).catch(() => null);
}
