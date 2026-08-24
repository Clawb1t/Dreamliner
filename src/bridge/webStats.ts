import type { Client, Guild } from "discord.js";
import {
  analyzeSeries,
  formatSharePct,
  sharePctValue,
  weekdayName,
  type SeriesAnalysis,
} from "../plugins/stats/functions/analysis.js";
import {
  formatStatsWindowLong,
  getDailyTotals,
  getFilledChannelDailyStats,
  getFilledDailyStats,
  getFilledUserDailyStats,
  isAllTimeWindow,
  isValidStatsWindow,
  shortDateLabel,
  type StatsWindow,
} from "../plugins/stats/functions/daily.js";
import {
  getFilledGlobalCommandDailyUses,
  getFilledGuildCommandDailyUses,
  getGlobalCommandUsesInWindow,
  getGlobalCommandUsesTotal,
  getGuildCommandUsesInWindow,
  getGuildCommandUsesTotal,
  getTopGlobalCommands,
  getTopGlobalCommandsByDaily,
  getTopGuildCommands,
  getTopGuildCommandsByDaily,
} from "../plugins/stats/functions/commandUsage.js";
import {
  getFilledGlobalDailyActiveUsers,
  getFilledGlobalDailyStats,
  getGlobalActiveMessagerCount,
  getGlobalDailyTotals,
  getGlobalTrackedMessagesTotal,
  getTopGlobalChannelsByDaily,
  getTopGlobalMessagers,
  getTopGlobalUsersByDaily,
  getTrackedGlobalDailyMessagesTotal,
  getTrackedGlobalMessagesTotal,
} from "../plugins/stats/functions/globalQueries.js";
import {
  getActiveMessagerCount,
  getChannelDailyTotal,
  getChannelTrackedMessages,
  getFilledDailyActiveUsers,
  getTopChannelsByDaily,
  getTopMessagers,
  getTopUsersByDaily,
  getTotalGuildMessages,
  getTrackedDailyMessagesTotal,
  getTrackedMessagesTotal,
  getUserMessageRank,
} from "../plugins/stats/functions/queries.js";
import {
  getGlobalMessageCount,
  getGuildMessageCount,
} from "../plugins/utility/functions/messageCounts.js";

function resolveCommandLeaders(
  entries: Array<{ commandName: string; count: number }>,
  trafficTotal: number,
) {
  return entries.map((entry, index) => ({
    rank: index + 1,
    id: entry.commandName,
    name: `/${entry.commandName}`,
    count: entry.count,
    sharePct: sharePctValue(entry.count, trafficTotal),
    shareLabel: formatSharePct(entry.count, trafficTotal),
  }));
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type WebStatsQuery = {
  days: StatsWindow;
};

function parseDays(raw: string | null): StatsWindow {
  const n = Number(raw ?? 14);
  return isValidStatsWindow(n) ? n : 14;
}

export function parseWebStatsQuery(url: URL): WebStatsQuery {
  return { days: parseDays(url.searchParams.get("days")) };
}

function toAnalysis(analysis: SeriesAnalysis, dates: string[]) {
  return {
    total: analysis.total,
    averagePerDay: Number(analysis.average.toFixed(2)),
    peakDate: dates[analysis.peakIndex] ?? null,
    peakValue: analysis.peakValue,
    activeDays: analysis.activeDays,
    recordedDays: dates.length,
    busiestWeekday: weekdayName(analysis.busiestWeekday),
    weekdayTotals: analysis.weekdayTotals,
    trend: analysis.trend,
    trendPct: Math.round(Math.abs(analysis.trendPct)),
  };
}

function weekdaySeries(totals: number[]) {
  return WEEKDAY_LABELS.map((day, i) => ({ day, value: totals[i] ?? 0 }));
}

function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value)))
    .toString(16)
    .padStart(6, "0")}`;
}

async function resolvePeople(
  guild: Guild,
  entries: Array<{ userId: string; count: number }>,
  trafficTotal: number,
  options?: { includeAccents?: boolean },
) {
  const includeAccents = options?.includeAccents !== false;
  const accents = includeAccents
    ? await (
        await import("./userProfiles.js")
      ).getAccentColorsForUsers(entries.map((entry) => entry.userId))
    : new Map<string, string>();
  return Promise.all(
    entries.map(async (entry, index) => {
      const member = await guild.members.fetch(entry.userId).catch(() => null);
      const user =
        member?.user ?? (await guild.client.users.fetch(entry.userId).catch(() => null));
      return {
        rank: index + 1,
        id: entry.userId,
        name: member?.displayName ?? user?.username ?? entry.userId,
        username: user?.username ?? null,
        avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
        count: entry.count,
        sharePct: sharePctValue(entry.count, trafficTotal),
        shareLabel: formatSharePct(entry.count, trafficTotal),
        accentColor: accents.get(entry.userId) ?? null,
      };
    }),
  );
}

function resolveChannels(
  guild: Guild,
  entries: Array<{ channelId: string; count: number }>,
  trafficTotal: number,
) {
  return entries.map((entry, index) => {
    const channel = guild.channels.cache.get(entry.channelId);
    return {
      rank: index + 1,
      id: entry.channelId,
      name: channel && "name" in channel ? `#${channel.name}` : `#${entry.channelId}`,
      count: entry.count,
      sharePct: sharePctValue(entry.count, trafficTotal),
      shareLabel: formatSharePct(entry.count, trafficTotal),
    };
  });
}

/** Public all-time messagers leaderboard for shareable website pages. */
export async function buildWebPublicMessagerLeaderboard(guild: Guild, limit = 25) {
  const capped = Math.min(50, Math.max(5, limit));
  const { configManager } = await import("../config/manager.js");
  const { isDreamlinerAeroActive } = await import("./dreamlinerAero.js");
  const [top, allTimeTrafficTotal, activeMessagers, guildConfig, oneActive] = await Promise.all([
    getTopMessagers(guild.id, capped),
    getTrackedMessagesTotal(guild.id, 0),
    getActiveMessagerCount(guild.id),
    configManager.getEffectiveConfig(guild.id),
    isDreamlinerAeroActive(guild.id),
  ]);
  const overrideUserAccents = Boolean(guildConfig.leaderboard_override_user_accents);
  const accentColor = colorIntToHex(guildConfig.server_accent_color);
  const leaders = await resolvePeople(guild, top, allTimeTrafficTotal, {
    includeAccents: !overrideUserAccents,
  });

  return {
    scope: "server" as const,
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      memberCount: guild.memberCount,
    },
    title: "Top messagers",
    subtitle: "All-time message leaderboard",
    windowLabel: "All time",
    totalMessages: allTimeTrafficTotal,
    activeMessagers,
    theme: {
      accentColor,
      overrideUserAccents,
    },
    oneActive,
    leaders,
  };
}

async function resolveGlobalPeople(
  client: Client,
  entries: Array<{ userId: string; count: number }>,
  trafficTotal: number,
) {
  const { getAccentColorsForUsers } = await import("./userProfiles.js");
  const accents = await getAccentColorsForUsers(entries.map((entry) => entry.userId));
  return Promise.all(
    entries.map(async (entry, index) => {
      const user = await client.users.fetch(entry.userId).catch(() => null);
      return {
        rank: index + 1,
        id: entry.userId,
        name: user?.globalName ?? user?.username ?? entry.userId,
        username: user?.username ?? null,
        avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
        count: entry.count,
        sharePct: sharePctValue(entry.count, trafficTotal),
        shareLabel: formatSharePct(entry.count, trafficTotal),
        accentColor: accents.get(entry.userId) ?? null,
      };
    }),
  );
}

function resolveGlobalChannels(
  client: Client,
  entries: Array<{ channelId: string; guildId: string; count: number }>,
  trafficTotal: number,
) {
  return entries.map((entry, index) => {
    const channel = client.channels.cache.get(entry.channelId);
    const guild = client.guilds.cache.get(entry.guildId);
    const channelName =
      channel && "name" in channel && typeof channel.name === "string"
        ? `#${channel.name}`
        : `#${entry.channelId}`;
    const guildName = guild?.name ?? "Unknown server";
    return {
      rank: index + 1,
      id: entry.channelId,
      name: `${guildName} · ${channelName}`,
      count: entry.count,
      sharePct: sharePctValue(entry.count, trafficTotal),
      shareLabel: formatSharePct(entry.count, trafficTotal),
    };
  });
}

/** Public all-time global messagers leaderboard across every tracked guild. */
export async function buildWebGlobalPublicMessagerLeaderboard(client: Client, limit = 25) {
  const capped = Math.min(50, Math.max(5, limit));
  const [top, allTimeTrafficTotal, activeMessagers] = await Promise.all([
    getTopGlobalMessagers(capped),
    getGlobalTrackedMessagesTotal(),
    getGlobalActiveMessagerCount(),
  ]);
  const leaders = await resolveGlobalPeople(client, top, allTimeTrafficTotal);

  return {
    scope: "global" as const,
    guild: {
      id: "global",
      name: "Dreamliner",
      icon: null as string | null,
      memberCount: client.guilds.cache.size,
    },
    title: "Top messagers",
    subtitle: "Global all-time message leaderboard",
    windowLabel: "All time · all servers",
    totalMessages: allTimeTrafficTotal,
    activeMessagers,
    leaders,
  };
}

/** JSON stats payload for website analytics (global / cross-guild scope). */
export async function buildWebGlobalStats(client: Client, query: WebStatsQuery) {
  const windowLabel = formatStatsWindowLong(query.days);
  const allTime = isAllTimeWindow(query.days);

  const [
    daily,
    totals,
    totalMessages,
    topAllTime,
    topRecent,
    topChannels,
    activeUsers,
    activeDaily,
    windowTrafficTotal,
    allTimeTrafficTotal,
    channelTrafficTotal,
    commandDaily,
    commandUsesLifetime,
    commandUsesWindow,
    topCommandsAllTime,
    topCommandsWindow,
  ] = await Promise.all([
    getFilledGlobalDailyStats(query.days),
    getGlobalDailyTotals(),
    getGlobalTrackedMessagesTotal(),
    getTopGlobalMessagers(15),
    allTime ? getTopGlobalMessagers(15) : getTopGlobalUsersByDaily(query.days, 15),
    getTopGlobalChannelsByDaily(query.days, 15),
    getGlobalActiveMessagerCount(),
    getFilledGlobalDailyActiveUsers(query.days),
    getTrackedGlobalMessagesTotal(query.days),
    getGlobalTrackedMessagesTotal(),
    getTrackedGlobalDailyMessagesTotal(query.days),
    getFilledGlobalCommandDailyUses(query.days),
    getGlobalCommandUsesTotal(),
    getGlobalCommandUsesInWindow(query.days),
    getTopGlobalCommands(15),
    allTime ? getTopGlobalCommands(15) : getTopGlobalCommandsByDaily(query.days, 15),
  ]);

  const dates = daily.map((r) => r.statDate);
  const msgAnalysis = analyzeSeries(
    daily.map((r) => r.messages),
    dates,
  );
  const joinAnalysis = analyzeSeries(
    daily.map((r) => r.joins),
    dates,
  );
  const leaveAnalysis = analyzeSeries(
    daily.map((r) => r.leaves),
    dates,
  );
  const editAnalysis = analyzeSeries(
    daily.map((r) => r.edits),
    dates,
  );
  const deleteAnalysis = analyzeSeries(
    daily.map((r) => r.deletes),
    dates,
  );
  const reactionAnalysis = analyzeSeries(
    daily.map((r) => r.reactions),
    dates,
  );
  const attachmentAnalysis = analyzeSeries(
    daily.map((r) => r.attachments),
    dates,
  );
  const membershipVolume = analyzeSeries(
    daily.map((r) => r.joins + r.leaves),
    dates,
  );
  const engagementVolume = analyzeSeries(
    daily.map((r) => r.edits + r.deletes + r.reactions + r.attachments),
    dates,
  );
  const activeUserCounts = activeDaily.map((r) => r.count);
  const activeUserDates = activeDaily.map((r) => r.statDate);
  const activeUserAnalysis = analyzeSeries(activeUserCounts, activeUserDates);

  const netMembers = joinAnalysis.total - leaveAnalysis.total;
  let cumulativeNet = 0;
  const seriesDaily = daily.map((row) => {
    const net = row.joins - row.leaves;
    cumulativeNet += net;
    const membership = row.joins + row.leaves;
    const engagement = row.edits + row.deletes + row.reactions + row.attachments;
    return {
      date: row.statDate,
      label: shortDateLabel(row.statDate),
      messages: row.messages,
      joins: row.joins,
      leaves: row.leaves,
      net,
      cumulativeNet,
      edits: row.edits,
      deletes: row.deletes,
      reactions: row.reactions,
      attachments: row.attachments,
      membershipVolume: membership,
      engagementVolume: engagement,
    };
  });

  const msgsPerActive = seriesDaily.map((row, i) => {
    const active = activeDaily[i]?.count ?? 0;
    return {
      date: row.date,
      label: row.label,
      value: active > 0 ? Number((row.messages / active).toFixed(2)) : 0,
    };
  });

  const [topRecentResolved, topAllTimeResolved] = await Promise.all([
    resolveGlobalPeople(client, topRecent, windowTrafficTotal),
    resolveGlobalPeople(client, topAllTime, allTimeTrafficTotal),
  ]);

  const commandDates = commandDaily.map((r) => r.statDate);
  const commandAnalysis = analyzeSeries(
    commandDaily.map((r) => r.uses),
    commandDates,
  );

  const windowEngagement = {
    edits: editAnalysis.total,
    deletes: deleteAnalysis.total,
    reactions: reactionAnalysis.total,
    attachments: attachmentAnalysis.total,
  };

  return {
    scope: "global" as const,
    guild: {
      id: "global",
      name: "Dreamliner",
      icon: null as string | null,
      memberCount: client.guilds.cache.size,
    },
    days: query.days,
    windowLabel,
    overview: {
      lifetimeMessages: totalMessages,
      activeMessagers: activeUsers,
      lifetimeCommands: commandUsesLifetime,
      windowCommands: commandUsesWindow,
      allTime: {
        messages: totals.messages,
        joins: totals.joins,
        leaves: totals.leaves,
        edits: totals.edits,
        deletes: totals.deletes,
        reactions: totals.reactions,
        attachments: totals.attachments,
      },
      windowEngagement,
      analysis: {
        messages: toAnalysis(msgAnalysis, dates),
        joins: toAnalysis(joinAnalysis, dates),
        leaves: toAnalysis(leaveAnalysis, dates),
        edits: toAnalysis(editAnalysis, dates),
        deletes: toAnalysis(deleteAnalysis, dates),
        reactions: toAnalysis(reactionAnalysis, dates),
        attachments: toAnalysis(attachmentAnalysis, dates),
        membershipVolume: toAnalysis(membershipVolume, dates),
        engagement: toAnalysis(engagementVolume, dates),
        activeUsers: toAnalysis(activeUserAnalysis, activeUserDates),
        commands: toAnalysis(commandAnalysis, commandDates),
        netMembers,
        peakDate: dates[msgAnalysis.peakIndex] ?? null,
        peakMessages: msgAnalysis.peakValue,
        busiestWeekday: weekdayName(msgAnalysis.busiestWeekday),
        trend: msgAnalysis.trend,
        trendPct: Math.round(Math.abs(msgAnalysis.trendPct)),
        recordedDays: daily.length,
        isAllTime: allTime,
        averagePerDay: Number(msgAnalysis.average.toFixed(1)),
        messagesTotal: msgAnalysis.total,
        joinsTotal: joinAnalysis.total,
        leavesTotal: leaveAnalysis.total,
      },
      trafficTotals: {
        window: windowTrafficTotal,
        allTime: allTimeTrafficTotal,
        channelsWindow: channelTrafficTotal,
        commandsWindow: commandUsesWindow,
        commandsAllTime: commandUsesLifetime,
      },
      topMessagersWindow: topRecentResolved,
      topMessagersAllTime: topAllTimeResolved,
      topChannels: resolveGlobalChannels(client, topChannels, channelTrafficTotal),
      topCommandsWindow: resolveCommandLeaders(topCommandsWindow, commandUsesWindow),
      topCommandsAllTime: resolveCommandLeaders(topCommandsAllTime, commandUsesLifetime),
    },
    series: {
      daily: seriesDaily,
      commands: commandDaily.map((row) => ({
        date: row.statDate,
        label: shortDateLabel(row.statDate),
        uses: row.uses,
      })),
      activeUsers: activeDaily.map((row) => ({
        date: row.statDate,
        label: shortDateLabel(row.statDate),
        count: row.count,
      })),
      messagesPerActiveUser: msgsPerActive,
      weekday: {
        messages: weekdaySeries(msgAnalysis.weekdayTotals),
        joins: weekdaySeries(joinAnalysis.weekdayTotals),
        leaves: weekdaySeries(leaveAnalysis.weekdayTotals),
        engagement: weekdaySeries(engagementVolume.weekdayTotals),
        activeUsers: weekdaySeries(activeUserAnalysis.weekdayTotals),
      },
      weekdayMessages: weekdaySeries(msgAnalysis.weekdayTotals),
      engagementMix: [
        { name: "Edits", value: windowEngagement.edits, color: "#EAB308" },
        { name: "Deletes", value: windowEngagement.deletes, color: "#EF4444" },
        { name: "Reactions", value: windowEngagement.reactions, color: "#EC4899" },
        { name: "Attachments", value: windowEngagement.attachments, color: "#22C55E" },
      ],
      allTimeMix: [
        { name: "Messages", value: totals.messages, color: "#5662f5" },
        { name: "Joins", value: totals.joins, color: "#22c55e" },
        { name: "Leaves", value: totals.leaves, color: "#ef4444" },
        { name: "Edits", value: totals.edits, color: "#EAB308" },
        { name: "Deletes", value: totals.deletes, color: "#f97316" },
        { name: "Reactions", value: totals.reactions, color: "#EC4899" },
        { name: "Attachments", value: totals.attachments, color: "#14b8a6" },
      ],
    },
  };
}

/** JSON stats payload for website analytics (server scope). */
export async function buildWebServerStats(guild: Guild, query: WebStatsQuery) {
  const guildId = guild.id;
  const windowLabel = formatStatsWindowLong(query.days);
  const allTime = isAllTimeWindow(query.days);

  const [
    daily,
    totals,
    totalMessages,
    topAllTime,
    topRecent,
    topChannels,
    activeUsers,
    activeDaily,
    windowTrafficTotal,
    allTimeTrafficTotal,
    channelTrafficTotal,
    commandDaily,
    commandUsesLifetime,
    commandUsesWindow,
    topCommandsAllTime,
    topCommandsWindow,
  ] = await Promise.all([
    getFilledDailyStats(guildId, query.days),
    getDailyTotals(guildId),
    getTotalGuildMessages(guildId),
    getTopMessagers(guildId, 15),
    allTime ? getTopMessagers(guildId, 15) : getTopUsersByDaily(guildId, query.days, 15),
    getTopChannelsByDaily(guildId, query.days, 15),
    getActiveMessagerCount(guildId),
    getFilledDailyActiveUsers(guildId, query.days),
    getTrackedMessagesTotal(guildId, query.days),
    getTrackedMessagesTotal(guildId, 0),
    getTrackedDailyMessagesTotal(guildId, query.days),
    getFilledGuildCommandDailyUses(guildId, query.days),
    getGuildCommandUsesTotal(guildId),
    getGuildCommandUsesInWindow(guildId, query.days),
    getTopGuildCommands(guildId, 15),
    allTime ? getTopGuildCommands(guildId, 15) : getTopGuildCommandsByDaily(guildId, query.days, 15),
  ]);

  const dates = daily.map((r) => r.statDate);
  const msgAnalysis = analyzeSeries(
    daily.map((r) => r.messages),
    dates,
  );
  const joinAnalysis = analyzeSeries(
    daily.map((r) => r.joins),
    dates,
  );
  const leaveAnalysis = analyzeSeries(
    daily.map((r) => r.leaves),
    dates,
  );
  const editAnalysis = analyzeSeries(
    daily.map((r) => r.edits),
    dates,
  );
  const deleteAnalysis = analyzeSeries(
    daily.map((r) => r.deletes),
    dates,
  );
  const reactionAnalysis = analyzeSeries(
    daily.map((r) => r.reactions),
    dates,
  );
  const attachmentAnalysis = analyzeSeries(
    daily.map((r) => r.attachments),
    dates,
  );
  const membershipVolume = analyzeSeries(
    daily.map((r) => r.joins + r.leaves),
    dates,
  );
  const engagementVolume = analyzeSeries(
    daily.map((r) => r.edits + r.deletes + r.reactions + r.attachments),
    dates,
  );
  const activeUserCounts = activeDaily.map((r) => r.count);
  const activeUserDates = activeDaily.map((r) => r.statDate);
  const activeUserAnalysis = analyzeSeries(activeUserCounts, activeUserDates);

  const netMembers = joinAnalysis.total - leaveAnalysis.total;
  let cumulativeNet = 0;
  const seriesDaily = daily.map((row) => {
    const net = row.joins - row.leaves;
    cumulativeNet += net;
    const membership = row.joins + row.leaves;
    const engagement = row.edits + row.deletes + row.reactions + row.attachments;
    return {
      date: row.statDate,
      label: shortDateLabel(row.statDate),
      messages: row.messages,
      joins: row.joins,
      leaves: row.leaves,
      net,
      cumulativeNet,
      edits: row.edits,
      deletes: row.deletes,
      reactions: row.reactions,
      attachments: row.attachments,
      membershipVolume: membership,
      engagementVolume: engagement,
    };
  });

  const msgsPerActive = seriesDaily.map((row, i) => {
    const active = activeDaily[i]?.count ?? 0;
    return {
      date: row.date,
      label: row.label,
      value: active > 0 ? Number((row.messages / active).toFixed(2)) : 0,
    };
  });

  const [topRecentResolved, topAllTimeResolved] = await Promise.all([
    resolvePeople(guild, topRecent, windowTrafficTotal),
    resolvePeople(guild, topAllTime, allTimeTrafficTotal),
  ]);

  const commandDates = commandDaily.map((r) => r.statDate);
  const commandAnalysis = analyzeSeries(
    commandDaily.map((r) => r.uses),
    commandDates,
  );

  const windowEngagement = {
    edits: editAnalysis.total,
    deletes: deleteAnalysis.total,
    reactions: reactionAnalysis.total,
    attachments: attachmentAnalysis.total,
  };

  return {
    scope: "server" as const,
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      memberCount: guild.memberCount,
    },
    days: query.days,
    windowLabel,
    overview: {
      lifetimeMessages: totalMessages,
      activeMessagers: activeUsers,
      lifetimeCommands: commandUsesLifetime,
      windowCommands: commandUsesWindow,
      allTime: {
        messages: totals.messages,
        joins: totals.joins,
        leaves: totals.leaves,
        edits: totals.edits,
        deletes: totals.deletes,
        reactions: totals.reactions,
        attachments: totals.attachments,
      },
      windowEngagement,
      analysis: {
        messages: toAnalysis(msgAnalysis, dates),
        joins: toAnalysis(joinAnalysis, dates),
        leaves: toAnalysis(leaveAnalysis, dates),
        edits: toAnalysis(editAnalysis, dates),
        deletes: toAnalysis(deleteAnalysis, dates),
        reactions: toAnalysis(reactionAnalysis, dates),
        attachments: toAnalysis(attachmentAnalysis, dates),
        membershipVolume: toAnalysis(membershipVolume, dates),
        engagement: toAnalysis(engagementVolume, dates),
        activeUsers: toAnalysis(activeUserAnalysis, activeUserDates),
        commands: toAnalysis(commandAnalysis, commandDates),
        netMembers,
        // Back-compat flat fields used by older UI bits
        peakDate: dates[msgAnalysis.peakIndex] ?? null,
        peakMessages: msgAnalysis.peakValue,
        busiestWeekday: weekdayName(msgAnalysis.busiestWeekday),
        trend: msgAnalysis.trend,
        trendPct: Math.round(Math.abs(msgAnalysis.trendPct)),
        recordedDays: daily.length,
        isAllTime: allTime,
        averagePerDay: Number(msgAnalysis.average.toFixed(1)),
        messagesTotal: msgAnalysis.total,
        joinsTotal: joinAnalysis.total,
        leavesTotal: leaveAnalysis.total,
      },
      trafficTotals: {
        window: windowTrafficTotal,
        allTime: allTimeTrafficTotal,
        channelsWindow: channelTrafficTotal,
        commandsWindow: commandUsesWindow,
        commandsAllTime: commandUsesLifetime,
      },
      topMessagersWindow: topRecentResolved,
      topMessagersAllTime: topAllTimeResolved,
      topChannels: resolveChannels(guild, topChannels, channelTrafficTotal),
      topCommandsWindow: resolveCommandLeaders(topCommandsWindow, commandUsesWindow),
      topCommandsAllTime: resolveCommandLeaders(topCommandsAllTime, commandUsesLifetime),
    },
    series: {
      daily: seriesDaily,
      commands: commandDaily.map((row) => ({
        date: row.statDate,
        label: shortDateLabel(row.statDate),
        uses: row.uses,
      })),
      activeUsers: activeDaily.map((row) => ({
        date: row.statDate,
        label: shortDateLabel(row.statDate),
        count: row.count,
      })),
      messagesPerActiveUser: msgsPerActive,
      weekday: {
        messages: weekdaySeries(msgAnalysis.weekdayTotals),
        joins: weekdaySeries(joinAnalysis.weekdayTotals),
        leaves: weekdaySeries(leaveAnalysis.weekdayTotals),
        engagement: weekdaySeries(engagementVolume.weekdayTotals),
        activeUsers: weekdaySeries(activeUserAnalysis.weekdayTotals),
      },
      // Back-compat
      weekdayMessages: weekdaySeries(msgAnalysis.weekdayTotals),
      engagementMix: [
        { name: "Edits", value: windowEngagement.edits, color: "#EAB308" },
        { name: "Deletes", value: windowEngagement.deletes, color: "#EF4444" },
        { name: "Reactions", value: windowEngagement.reactions, color: "#EC4899" },
        { name: "Attachments", value: windowEngagement.attachments, color: "#22C55E" },
      ],
      allTimeMix: [
        { name: "Messages", value: totals.messages, color: "#5662f5" },
        { name: "Joins", value: totals.joins, color: "#22c55e" },
        { name: "Leaves", value: totals.leaves, color: "#ef4444" },
        { name: "Edits", value: totals.edits, color: "#EAB308" },
        { name: "Deletes", value: totals.deletes, color: "#f97316" },
        { name: "Reactions", value: totals.reactions, color: "#EC4899" },
        { name: "Attachments", value: totals.attachments, color: "#14b8a6" },
      ],
    },
  };
}

export async function buildWebUserStats(guild: Guild, userId: string, query: WebStatsQuery) {
  const guildId = guild.id;
  const windowLabel = formatStatsWindowLong(query.days);
  const [
    daily,
    guildCount,
    globalCount,
    serverTotal,
    activeUsers,
    serverTrafficTotal,
  ] = await Promise.all([
    getFilledUserDailyStats(guildId, userId, query.days),
    getGuildMessageCount(guildId, userId),
    getGlobalMessageCount(userId),
    getTotalGuildMessages(guildId),
    getActiveMessagerCount(guildId),
    getTrackedMessagesTotal(guildId, query.days),
  ]);
  const rank = await getUserMessageRank(guildId, userId, guildCount);
  const dates = daily.map((r) => r.statDate);
  const analysis = analyzeSeries(
    daily.map((r) => r.messages),
    dates,
  );
  const userMessagesInWindow = isAllTimeWindow(query.days) ? guildCount : analysis.total;
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));

  return {
    scope: "user" as const,
    guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    days: query.days,
    windowLabel,
    entity: {
      id: userId,
      name: member?.displayName ?? user?.username ?? userId,
      username: user?.username ?? null,
      avatar: user?.displayAvatarURL({ size: 128 }) ?? null,
    },
    lifetimeGuild: guildCount,
    lifetimeGlobal: globalCount,
    rank,
    activeMessagerPool: activeUsers,
    shareOfLifetimeTrafficPct: sharePctValue(guildCount, serverTotal),
    shareOfLifetimeTrafficLabel: formatSharePct(guildCount, serverTotal),
    shareOfWindowTrafficPct: sharePctValue(userMessagesInWindow, serverTrafficTotal),
    shareOfWindowTrafficLabel: formatSharePct(userMessagesInWindow, serverTrafficTotal),
    analysis: toAnalysis(analysis, dates),
    series: {
      daily: daily.map((row) => ({
        date: row.statDate,
        label: shortDateLabel(row.statDate),
        value: row.messages,
      })),
      weekday: weekdaySeries(analysis.weekdayTotals),
    },
    sharePie: [
      { name: "This user", value: userMessagesInWindow, color: "#5662f5" },
      {
        name: "Everyone else",
        value: Math.max(0, serverTrafficTotal - userMessagesInWindow),
        color: "#d1d5db",
      },
    ],
  };
}

export async function buildWebChannelStats(guild: Guild, channelId: string, query: WebStatsQuery) {
  const guildId = guild.id;
  const windowLabel = formatStatsWindowLong(query.days);
  const [daily, lifetimeStats, retainedLogs, serverTrafficTotal] = await Promise.all([
    getFilledChannelDailyStats(guildId, channelId, query.days),
    getChannelDailyTotal(guildId, channelId),
    getChannelTrackedMessages(guildId, channelId),
    getTrackedDailyMessagesTotal(guildId, query.days),
  ]);
  const dates = daily.map((r) => r.statDate);
  const analysis = analyzeSeries(
    daily.map((r) => r.messages),
    dates,
  );
  const channelMessagesInWindow = isAllTimeWindow(query.days) ? lifetimeStats : analysis.total;
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  const createdAt =
    channel && "createdAt" in channel && channel.createdAt
      ? channel.createdAt.toISOString()
      : null;

  return {
    scope: "channel" as const,
    guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    days: query.days,
    windowLabel,
    entity: {
      id: channelId,
      name: channel && "name" in channel ? `#${channel.name}` : `#${channelId}`,
      createdAt,
    },
    lifetimeStatsMessages: lifetimeStats,
    retainedLogMessages: retainedLogs,
    shareOfWindowTrafficPct: sharePctValue(channelMessagesInWindow, serverTrafficTotal),
    shareOfWindowTrafficLabel: formatSharePct(channelMessagesInWindow, serverTrafficTotal),
    analysis: toAnalysis(analysis, dates),
    series: {
      daily: daily.map((row) => ({
        date: row.statDate,
        label: shortDateLabel(row.statDate),
        value: row.messages,
      })),
      weekday: weekdaySeries(analysis.weekdayTotals),
    },
    sharePie: [
      { name: "This channel", value: channelMessagesInWindow, color: "#5662f5" },
      {
        name: "Other channels",
        value: Math.max(0, serverTrafficTotal - channelMessagesInWindow),
        color: "#d1d5db",
      },
    ],
  };
}
