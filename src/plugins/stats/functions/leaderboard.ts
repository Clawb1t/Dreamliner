import type { Guild } from "discord.js";
import { DREAMLINER_ACCENT_HEX } from "../../../core/embeds.js";
import { formatSharePct } from "./analysis.js";
import { formatStatsWindowLong, getFilledDailyStats, getDailyTotals, isAllTimeWindow, isValidStatsWindow } from "./daily.js";
import { getTopChannelsByDaily, getTopMessagers, getTopUsersByDaily, getTotalGuildMessages } from "./queries.js";
import { renderLeaderboardImage, type LeaderboardRow } from "./charts.js";

async function windowMessageTotal(guildId: string, days: number): Promise<number> {
  if (isAllTimeWindow(days)) {
    const totals = await getDailyTotals(guildId);
    return totals.messages;
  }
  const daily = await getFilledDailyStats(guildId, days);
  return daily.reduce((sum, row) => sum + row.messages, 0);
}

function windowCaption(days: number, kind: string): string {
  if (!isValidStatsWindow(days)) return `${kind} · ${days} days`;
  return `${kind} · ${formatStatsWindowLong(days).toLowerCase()}`;
}

async function resolveUserRow(
  guild: Guild,
  rank: number,
  userId: string,
  count: number,
  total: number,
): Promise<LeaderboardRow> {
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  return {
    rank,
    label: member?.displayName ?? user?.username ?? `User ${userId.slice(-4)}`,
    count,
    shareLabel: formatSharePct(count, total),
    avatarURL: user?.displayAvatarURL({ size: 128, extension: "png" }) ?? null,
  };
}

async function resolveChannelRow(
  guild: Guild,
  rank: number,
  channelId: string,
  count: number,
  total: number,
): Promise<LeaderboardRow> {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  const name = channel && "name" in channel ? channel.name : "unknown";
  return {
    rank,
    label: `#${name}`,
    count,
    shareLabel: formatSharePct(count, total),
    avatarURL: null,
    fallbackInitial: name.charAt(0).toUpperCase() || "#",
  };
}

export async function renderUsersLeaderboard(
  guild: Guild,
  days: number,
  title: string,
  subtitle: string,
): Promise<{ buffer: Buffer; caption: string }> {
  const guildId = guild.id;
  const [top, total] = await Promise.all([getTopUsersByDaily(guildId, days, 10), windowMessageTotal(guildId, days)]);
  const rows = await Promise.all(top.map((entry, i) => resolveUserRow(guild, i + 1, entry.userId, entry.count, total)));
  return {
    buffer: await renderLeaderboardImage({ title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }),
    caption: windowCaption(days, "Top messagers"),
  };
}

export async function renderChannelsLeaderboard(
  guild: Guild,
  days: number,
  title: string,
  subtitle: string,
): Promise<{ buffer: Buffer; caption: string }> {
  const guildId = guild.id;
  const [top, total] = await Promise.all([getTopChannelsByDaily(guildId, days, 10), windowMessageTotal(guildId, days)]);
  const rows = await Promise.all(
    top.map((entry, i) => resolveChannelRow(guild, i + 1, entry.channelId, entry.count, total)),
  );
  return {
    buffer: await renderLeaderboardImage({ title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }),
    caption: windowCaption(days, "Top channels"),
  };
}

export async function renderAllTimeUsersLeaderboard(
  guild: Guild,
  title: string,
  subtitle: string,
): Promise<{ buffer: Buffer; caption: string }> {
  const guildId = guild.id;
  const top = await getTopMessagers(guildId, 10);
  const total = await getTotalGuildMessages(guildId);
  const rows = await Promise.all(top.map((entry, i) => resolveUserRow(guild, i + 1, entry.userId, entry.count, total)));
  return {
    buffer: await renderLeaderboardImage({ title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }),
    caption: "All-time top messagers",
  };
}
