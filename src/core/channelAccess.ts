import { ChannelType, PermissionFlagsBits, type GuildBasedChannel } from "discord.js";

/**
 * Whether a member may read a channel's messages themselves: View Channel and Read Message History
 * there, and for a private thread, being in it (or Manage Threads; Discord's permission maths
 * doesn't cover private-thread membership).
 *
 * Use it before showing a member anything the bot fetched on their behalf (message links, message
 * IDs): the bot can usually see far more channels than the person asking, and without this check
 * a command becomes a way to read channels they're not allowed in.
 */
export async function memberCanReadChannel(channel: GuildBasedChannel, userId: string): Promise<boolean> {
  const guild = channel.guild;
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  if (!member) return false;

  const permissions = channel.permissionsFor(member);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) return false;

  if (channel.type === ChannelType.PrivateThread && !permissions.has(PermissionFlagsBits.ManageThreads)) {
    if (channel.members.cache.has(userId)) return true;
    return Boolean(await channel.members.fetch(userId).catch(() => null));
  }
  return true;
}
