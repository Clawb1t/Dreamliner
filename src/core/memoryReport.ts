import type { Client } from "discord.js";
import { getLogger } from "./logger.js";

const log = getLogger("memory");
const MB = 1024 * 1024;

/** Counts of the discord.js caches that can grow with traffic. */
export function discordCacheSizes(client: Client): Record<string, number> {
  let channels = 0;
  let members = 0;
  let messages = 0;
  let voiceStates = 0;
  for (const guild of client.guilds.cache.values()) {
    members += guild.members.cache.size;
    voiceStates += guild.voiceStates.cache.size;
  }
  for (const channel of client.channels.cache.values()) {
    channels += 1;
    if ("messages" in channel && channel.messages) messages += channel.messages.cache.size;
  }
  return {
    guilds: client.guilds.cache.size,
    channels,
    users: client.users.cache.size,
    members,
    messages,
    voiceStates,
  };
}

/** One line: process memory (MB) plus cache sizes, for spotting anything that still climbs. */
export function memoryReportLine(client: Client): string {
  const usage = process.memoryUsage();
  const caches = discordCacheSizes(client);
  const mem = `rss=${Math.round(usage.rss / MB)}MB heap=${Math.round(usage.heapUsed / MB)}/${Math.round(usage.heapTotal / MB)}MB external=${Math.round(usage.external / MB)}MB buffers=${Math.round(usage.arrayBuffers / MB)}MB`;
  const counts = Object.entries(caches)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `${mem} | ${counts}`;
}

export function logMemoryReport(client: Client): void {
  log.info(memoryReportLine(client));
}
