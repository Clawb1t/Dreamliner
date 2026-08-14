import {
  PermissionFlagsBits,
  type GuildTextBasedChannel,
  type TextChannel,
  type Webhook,
} from "discord.js";

const WEBHOOK_NAME = "Dreamliner Persist";

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

export async function getPersistWebhook(channel: GuildTextBasedChannel): Promise<Webhook | null> {
  const textChannel = asWebhookChannel(channel);
  if (!textChannel) return null;

  const me = textChannel.guild.members.me;
  if (!me?.permissionsIn(textChannel).has(PermissionFlagsBits.ManageWebhooks)) {
    return null;
  }

  try {
    const existing = await textChannel.fetchWebhooks();
    const owned = existing.find((hook) => hook.owner?.id === me.id && hook.name === WEBHOOK_NAME);
    if (owned) {
      persistWebhookIds.add(owned.id);
      return owned;
    }

    const created = await textChannel.createWebhook({
      name: WEBHOOK_NAME,
      reason: "Sticky persist messages with custom name and avatar",
    });
    persistWebhookIds.add(created.id);
    return created;
  } catch {
    return null;
  }
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
