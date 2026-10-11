import type { Channel, Client } from "discord.js";

const SNOWFLAKE = /^\d{15,25}$/;

/**
 * A channel (or thread) by id, ONLY when it belongs to `guildId`.
 *
 * Channel ids come from guild config, dashboard input and stored rows, and `client.channels.fetch`
 * happily returns a channel from any server the bot is in. Without this check an admin of one server
 * could point a log channel, panel, feed or board at a channel in someone else's server and make the
 * bot post, edit or delete there. Every lookup of a channel id that didn't come straight from a
 * Discord event in the same guild should go through here.
 */
export async function fetchGuildChannel(client: Client, guildId: string | null | undefined, channelId: string | null | undefined): Promise<Channel | null> {
  if (!guildId || !channelId || !SNOWFLAKE.test(channelId)) return null;
  const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !("guildId" in channel) || channel.guildId !== guildId) return null;
  return channel;
}

/** Same as {@link fetchGuildChannel}, narrowed to channels the bot can send messages in. */
export async function fetchGuildTextChannel(client: Client, guildId: string | null | undefined, channelId: string | null | undefined) {
  const channel = await fetchGuildChannel(client, guildId, channelId);
  return channel?.isTextBased() && channel.isSendable() ? channel : null;
}

/** True when `channelId` is a channel in `guildId` (for validating ids before they're saved). */
export async function isGuildChannel(client: Client, guildId: string, channelId: string): Promise<boolean> {
  return (await fetchGuildChannel(client, guildId, channelId)) !== null;
}

/**
 * Checks ids a dashboard request wants to save for this guild: the channel must be one of its
 * channels and every role one of its roles. Returns an error message, or null when they're fine.
 */
export async function validateGuildTargets(
  guild: import("discord.js").Guild,
  input: { discordChannelId?: unknown; mentionRoleIds?: unknown },
): Promise<string | null> {
  if (input.discordChannelId !== undefined) {
    if (typeof input.discordChannelId !== "string" || !(await isGuildChannel(guild.client, guild.id, input.discordChannelId))) {
      return "That channel isn't in this server.";
    }
  }
  if (input.mentionRoleIds !== undefined) {
    const ids = Array.isArray(input.mentionRoleIds) ? input.mentionRoleIds : [];
    if (ids.some((id) => typeof id !== "string" || !guild.roles.cache.has(id))) return "One of those roles isn't in this server.";
  }
  return null;
}
