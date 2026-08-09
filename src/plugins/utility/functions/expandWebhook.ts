import {
  PermissionFlagsBits,
  type GuildTextBasedChannel,
  type TextChannel,
  type Webhook,
} from "discord.js";

const WEBHOOK_NAME = "Dreamliner Expand";

function asWebhookChannel(channel: GuildTextBasedChannel): TextChannel | null {
  if (!channel.isTextBased() || channel.isDMBased()) return null;
  if (!("fetchWebhooks" in channel) || typeof channel.fetchWebhooks !== "function") return null;
  if (!("createWebhook" in channel) || typeof channel.createWebhook !== "function") return null;
  return channel as TextChannel;
}

/** Reuse a per-channel webhook so message-link expands can spoof the original author. */
export async function getExpandMessageWebhook(channel: GuildTextBasedChannel): Promise<Webhook | null> {
  const textChannel = asWebhookChannel(channel);
  if (!textChannel) return null;

  const me = textChannel.guild.members.me;
  if (!me?.permissionsIn(textChannel).has(PermissionFlagsBits.ManageWebhooks)) {
    return null;
  }

  try {
    const existing = await textChannel.fetchWebhooks();
    const owned = existing.find((hook) => hook.owner?.id === me.id && hook.name === WEBHOOK_NAME);
    if (owned) return owned;

    return await textChannel.createWebhook({
      name: WEBHOOK_NAME,
      reason: "Expand pasted Discord message links with original author avatar",
    });
  } catch {
    return null;
  }
}
