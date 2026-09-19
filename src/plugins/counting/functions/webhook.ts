import {
  PermissionFlagsBits,
  type GuildTextBasedChannel,
  type TextChannel,
  type Webhook,
} from "discord.js";

const COUNTING_WEBHOOK_NAME = "Dreamliner Counting";

function asWebhookChannel(channel: GuildTextBasedChannel): TextChannel | null {
  if (!channel.isTextBased() || channel.isDMBased()) return null;
  if (!("fetchWebhooks" in channel) || typeof channel.fetchWebhooks !== "function") return null;
  if (!("createWebhook" in channel) || typeof channel.createWebhook !== "function") return null;
  return channel as TextChannel;
}

export async function getCountingWebhook(channel: GuildTextBasedChannel): Promise<Webhook | null> {
  const textChannel = asWebhookChannel(channel);
  if (!textChannel) return null;

  const me = textChannel.guild.members.me;
  if (!me?.permissionsIn(textChannel).has(PermissionFlagsBits.ManageWebhooks)) {
    return null;
  }

  try {
    const existing = await textChannel.fetchWebhooks();
    const owned = existing.find((hook) => hook.owner?.id === me.id && hook.name === COUNTING_WEBHOOK_NAME);
    if (owned) return owned;
    return await textChannel.createWebhook({
      name: COUNTING_WEBHOOK_NAME,
      reason: "Counting messages with a custom name and avatar",
    });
  } catch {
    return null;
  }
}
