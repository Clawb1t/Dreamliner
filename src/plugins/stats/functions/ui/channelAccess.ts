import type { Guild } from "discord.js";
import { memberCanReadChannel } from "../../../../core/channelAccess.js";

/** Channel stats show a channel's name and activity: only for members who can read that channel. */
export async function canViewStatsChannel(guild: Guild, channelId: string, userId: string): Promise<boolean> {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  return Boolean(channel && (await memberCanReadChannel(channel, userId)));
}
