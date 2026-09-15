import type { Guild } from "discord.js";
import { DREAMLINER_ACCENT_HEX } from "../../../core/embeds.js";
import { formatSharePct, sharePctValue } from "./analysis.js";
import { formatStatsWindowLong, isAllTimeWindow, isValidStatsWindow } from "./daily.js";
import { getTopChannelsByDaily, getTopMessagers, getTopUsersByDaily, getTrackedDailyMessagesTotal, getTrackedMessagesTotal } from "./queries.js";
import { renderLeaderboardImage, type LeaderboardRow } from "./charts.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

function windowCaption(days: number, kind: string, t: Translator): string {
  if (!isValidStatsWindow(days)) return t("stats.captionKindDays", "{kind} · {days} days", { kind, days });
  return t("stats.captionKindWindow", "{kind} · {window}", { kind, window: formatStatsWindowLong(days, t).toLowerCase() });
}

async function resolveUserRow(
  guild: Guild,
  rank: number,
  userId: string,
  count: number,
  total: number,
  t: Translator,
): Promise<LeaderboardRow> {
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  return {
    rank,
    label: member?.displayName ?? user?.username ?? t("stats.unknownUserFallback", "User {suffix}", { suffix: userId.slice(-4) }),
    count,
    shareLabel: formatSharePct(count, total),
    sharePct: sharePctValue(count, total),
    avatarURL: user?.displayAvatarURL({ size: 128, extension: "png" }) ?? null,
  };
}

async function resolveChannelRow(
  guild: Guild,
  rank: number,
  channelId: string,
  count: number,
  total: number,
  t: Translator,
): Promise<LeaderboardRow> {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  const name = channel && "name" in channel ? channel.name : t("stats.unknownChannelFallback", "unknown");
  return {
    rank,
    label: `#${name}`,
    count,
    shareLabel: formatSharePct(count, total),
    sharePct: sharePctValue(count, total),
    avatarURL: null,
    fallbackInitial: name.charAt(0).toUpperCase() || "#",
  };
}

export async function renderUsersLeaderboard(
  guild: Guild,
  days: number,
  title: string,
  subtitle: string,
  t: Translator = defaultTranslator,
): Promise<{ buffer: Buffer; caption: string }> {
  const guildId = guild.id;
  const [top, total] = await Promise.all([
    isAllTimeWindow(days) ? getTopMessagers(guildId, 10) : getTopUsersByDaily(guildId, days, 10),
    getTrackedMessagesTotal(guildId, days),
  ]);
  const rows = await Promise.all(top.map((entry, i) => resolveUserRow(guild, i + 1, entry.userId, entry.count, total, t)));
  return {
    buffer: await renderLeaderboardImage({ title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }, t),
    caption: windowCaption(days, t("stats.leaderboardTopMessagers", "Top messagers"), t),
  };
}

export async function renderChannelsLeaderboard(
  guild: Guild,
  days: number,
  title: string,
  subtitle: string,
  t: Translator = defaultTranslator,
): Promise<{ buffer: Buffer; caption: string }> {
  const guildId = guild.id;
  const [top, total] = await Promise.all([
    getTopChannelsByDaily(guildId, days, 10),
    getTrackedDailyMessagesTotal(guildId, days),
  ]);
  const rows = await Promise.all(
    top.map((entry, i) => resolveChannelRow(guild, i + 1, entry.channelId, entry.count, total, t)),
  );
  return {
    buffer: await renderLeaderboardImage({ title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }, t),
    caption: windowCaption(days, t("stats.leaderboardTopChannels", "Top channels"), t),
  };
}

export async function renderAllTimeUsersLeaderboard(
  guild: Guild,
  title: string,
  subtitle: string,
  t: Translator = defaultTranslator,
): Promise<{ buffer: Buffer; caption: string }> {
  const guildId = guild.id;
  const [top, total] = await Promise.all([getTopMessagers(guildId, 10), getTrackedMessagesTotal(guildId, 0)]);
  const rows = await Promise.all(top.map((entry, i) => resolveUserRow(guild, i + 1, entry.userId, entry.count, total, t)));
  return {
    buffer: await renderLeaderboardImage({ title, subtitle, rows, accentColor: DREAMLINER_ACCENT_HEX }, t),
    caption: t("stats.captionAllTimeTopMessagers", "All-time top messagers"),
  };
}
