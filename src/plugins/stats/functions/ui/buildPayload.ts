import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type Client,
  type Guild,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { GuildConfig } from "../../../../config/schemas/guild.js";
import { getGlobalLeaderboardUrl } from "../../../../core/docsUrl.js";
import { publicLeaderboardUrl } from "../../../../core/publicLeaderboard.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines, type ResultContainer } from "../../../../core/embeds.js";
import { getGuildMessageCount, getGlobalMessageCount } from "../../../utility/functions/messageCounts.js";
import {
  formatStatsWindowLabel,
  formatStatsWindowLong,
  getDailyTotals,
  isAllTimeWindow,
  type StatsWindow,
} from "../daily.js";
import { getFilledChannelDailyStats, getFilledDailyStats, getFilledUserDailyStats } from "../daily.js";
import {
  getActiveMessagerCount,
  getChannelDailyTotal,
  getChannelTrackedMessages,
  getTopChannelsByDaily,
  getTopMessagers,
  getTopUsersByDaily,
  getTotalGuildMessages,
  getTrackedDailyMessagesTotal,
  getTrackedMessagesTotal,
  getUserMessageRank,
} from "../queries.js";
import { analyzeSeries, formatTrend, pct, weekdayName } from "../analysis.js";
import { renderStatsChart } from "./renderCharts.js";
import { buildCustomId, categoriesFor, categoryDef, type StatsState } from "./state.js";
import { defaultTranslator, type Translator } from "../../../../i18n/index.js";

function windowLabel(days: StatsWindow, t: Translator): string {
  return formatStatsWindowLong(days, t);
}

function windowSpan(days: StatsWindow, recordedDays: number, t: Translator): string {
  if (isAllTimeWindow(days)) return t("stats.recordedDays", "{count} recorded days", { count: recordedDays });
  return String(days);
}

function statDateTimestamp(statDate: string): number {
  return Math.floor(Date.parse(`${statDate}T12:00:00Z`) / 1000);
}

function formatStatDate(statDate: string | undefined): string {
  if (!statDate) return "—";
  return `<t:${statDateTimestamp(statDate)}:D>`;
}

function scopeTitle(scope: StatsState["scope"], guild: Guild, t: Translator): string {
  if (scope.type === "server") return t("stats.scopeTitleServer", "{guildName} stats", { guildName: guild.name });
  if (scope.type === "user") return t("stats.scopeTitleUser", "User stats");
  return t("stats.scopeTitleChannel", "Channel stats");
}

function scopeEmoji(scope: StatsState["scope"]): string {
  if (scope.type === "server") return "<:icons_serverinsight:1544417809109352489>";
  if (scope.type === "user") return "<:icons_Person:1544417372260278353>";
  return "<:icons_channel:1544417183734431805>";
}

async function buildHomeFields(state: StatsState, guild: Guild, t: Translator) {
  const guildId = guild.id;
  const { days } = state;

  if (state.scope.type === "server") {
    const [daily, totals, totalMessages, topAllTime, topRecent, topChannels, activeUsers] = await Promise.all([
      getFilledDailyStats(guildId, days),
      getDailyTotals(guildId),
      getTotalGuildMessages(guildId),
      getTopMessagers(guildId, 5),
      getTopUsersByDaily(guildId, days, 5),
      getTopChannelsByDaily(guildId, days, 5),
      getActiveMessagerCount(guildId),
    ]);
    const dates = daily.map((r) => r.statDate);
    const msgAnalysis = analyzeSeries(daily.map((r) => r.messages), dates);
    const joinAnalysis = analyzeSeries(daily.map((r) => r.joins), dates);
    const leaveAnalysis = analyzeSeries(daily.map((r) => r.leaves), dates);
    const netMembers = joinAnalysis.total - leaveAnalysis.total;

    return [
      embedField(
        t("stats.fieldOverview", "Overview"),
        trimLines(
          t(
            "stats.overviewBody",
            "Lifetime tracked messages: `{totalMessages}`\nActive messagers: `{activeUsers}`\nAll-time daily totals: `{totalsMessages}` msgs · `{totalsJoins}` joins · `{totalsLeaves}` leaves",
            {
              totalMessages: totalMessages.toLocaleString(),
              activeUsers: activeUsers.toLocaleString(),
              totalsMessages: totals.messages.toLocaleString(),
              totalsJoins: totals.joins,
              totalsLeaves: totals.leaves,
            },
          ),
        ),
      ),
      embedField(
        t("stats.fieldAnalysisWindow", "Analysis ({window})", { window: windowLabel(days, t) }),
        trimLines(
          t(
            "stats.serverAnalysisBody",
            "Messages: `{msgTotal}` (avg `{msgAverage}`/day)\nJoins / leaves: `{joinsTotal}` / `{leavesTotal}` (net `{netMembers}`)\nPeak day: {peakDate} · `{peakValue}` msgs\nBusiest weekday: **{busiestWeekday}**\nTrend: {trend}",
            {
              msgTotal: msgAnalysis.total.toLocaleString(),
              msgAverage: msgAnalysis.average.toFixed(1),
              joinsTotal: joinAnalysis.total,
              leavesTotal: leaveAnalysis.total,
              netMembers: `${netMembers >= 0 ? "+" : ""}${netMembers}`,
              peakDate: formatStatDate(dates[msgAnalysis.peakIndex]),
              peakValue: msgAnalysis.peakValue.toLocaleString(),
              busiestWeekday: weekdayName(msgAnalysis.busiestWeekday, t),
              trend: formatTrend(msgAnalysis.trend, msgAnalysis.trendPct, t),
            },
          ),
        ),
      ),
      embedField(
        t("stats.fieldEngagementTotals", "Engagement totals"),
        trimLines(
          t(
            "stats.engagementTotalsBody",
            "Edits: `{edits}`\nDeletes: `{deletes}`\nReactions: `{reactions}`\nAttachments: `{attachments}`",
            {
              edits: totals.edits.toLocaleString(),
              deletes: totals.deletes.toLocaleString(),
              reactions: totals.reactions.toLocaleString(),
              attachments: totals.attachments.toLocaleString(),
            },
          ),
        ),
      ),
      embedField(
        t("stats.fieldTopMessagersWindow", "Top messagers ({window})", { window: windowLabel(days, t) }),
        topRecent.length
          ? topRecent.map((e, i) => `${i + 1}. <@${e.userId}> · \`${e.count.toLocaleString()}\``).join("\n")
          : t("stats.noRecentMessageData", "No recent daily message data yet."),
        true,
      ),
      embedField(
        t("stats.fieldTopMessagersAllTime", "Top messagers (all-time)"),
        topAllTime.length
          ? topAllTime.map((e, i) => `${i + 1}. <@${e.userId}> · \`${e.count.toLocaleString()}\``).join("\n")
          : t("stats.noMessageData", "No message data yet."),
        true,
      ),
      embedField(
        t("stats.fieldTopChannelsWindow", "Top channels ({window})", { window: windowLabel(days, t) }),
        topChannels.length
          ? topChannels.map((e, i) => `${i + 1}. <#${e.channelId}> · \`${e.count.toLocaleString()}\``).join("\n")
          : t("stats.noChannelActivity", "No channel activity recorded yet."),
      ),
    ];
  }

  if (state.scope.type === "user") {
    const userId = state.scope.userId;
    const [guildCount, globalCount, daily, serverTotal, activeUsers] = await Promise.all([
      getGuildMessageCount(guildId, userId),
      getGlobalMessageCount(userId),
      getFilledUserDailyStats(guildId, userId, days),
      getTotalGuildMessages(guildId),
      getActiveMessagerCount(guildId),
    ]);
    const rank = await getUserMessageRank(guildId, userId, guildCount);
    const dates = daily.map((r) => r.statDate);
    const analysis = analyzeSeries(daily.map((r) => r.messages), dates);
    const serverTrafficTotal = await getTrackedMessagesTotal(guildId, days);
    const userMessagesInWindow = isAllTimeWindow(days) ? guildCount : analysis.total;
    const user = await guild.client.users.fetch(userId).catch(() => null);

    return [
      embedField(t("stats.fieldUser", "User"), user ? `<@${user.id}> (\`${user.tag}\`)` : `<@${userId}>`),
      embedField(
        t("stats.fieldLifetimeTotals", "Lifetime totals"),
        trimLines(
          t(
            "stats.userLifetimeTotalsBody",
            "This server: `{guildCount}` ({pct} of tracked traffic)\nAll servers: `{globalCount}`\nRank here: `#{rank}` of `{activeUsers}` active messagers",
            {
              guildCount: guildCount.toLocaleString(),
              pct: pct(guildCount, serverTotal),
              globalCount: globalCount.toLocaleString(),
              rank: rank || "—",
              activeUsers: activeUsers.toLocaleString(),
            },
          ),
        ),
      ),
      embedField(
        t("stats.fieldAnalysisWindow", "Analysis ({window})", { window: windowLabel(days, t) }),
        trimLines(
          t(
            "stats.userAnalysisBody",
            "Messages: `{total}` (avg `{average}`/day)\nActive days: `{activeDays}/{windowSpan}`\nPeak day: {peakDate} · `{peakValue}` msgs\nShare of server traffic: `{sharePct}`\nBusiest weekday: **{busiestWeekday}**\nTrend: {trend}",
            {
              total: analysis.total.toLocaleString(),
              average: analysis.average.toFixed(1),
              activeDays: analysis.activeDays,
              windowSpan: windowSpan(days, daily.length, t),
              peakDate: formatStatDate(dates[analysis.peakIndex]),
              peakValue: analysis.peakValue.toLocaleString(),
              sharePct: pct(userMessagesInWindow, serverTrafficTotal),
              busiestWeekday: weekdayName(analysis.busiestWeekday, t),
              trend: formatTrend(analysis.trend, analysis.trendPct, t),
            },
          ),
        ),
      ),
    ];
  }

  const channelId = state.scope.channelId;
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  const [daily, trackedLogs, lifetimeDaily, serverTrafficTotal] = await Promise.all([
    getFilledChannelDailyStats(guildId, channelId, days),
    getChannelTrackedMessages(guildId, channelId),
    getChannelDailyTotal(guildId, channelId),
    getTrackedDailyMessagesTotal(guildId, days),
  ]);
  const dates = daily.map((r) => r.statDate);
  const analysis = analyzeSeries(daily.map((r) => r.messages), dates);
  const channelMessagesInWindow = isAllTimeWindow(days) ? lifetimeDaily : analysis.total;
  const created =
    channel && "createdTimestamp" in channel && channel.createdTimestamp
      ? `<t:${Math.floor(channel.createdTimestamp / 1000)}:R>`
      : t("stats.unknownFallback", "Unknown");

  return [
    embedField(t("stats.fieldChannel", "Channel"), channel && "name" in channel ? `<#${channel.id}> (\`${channel.name}\`)` : `<#${channelId}>`),
    embedField(
      t("stats.fieldOverview", "Overview"),
      trimLines(
        t(
          "stats.channelOverviewBody",
          "Created: {created}\nTracked by stats: `{lifetimeDaily}` msgs\nCurrently retained in logs: `{trackedLogs}`",
          {
            created,
            lifetimeDaily: lifetimeDaily.toLocaleString(),
            trackedLogs: trackedLogs.toLocaleString(),
          },
        ),
      ),
    ),
    embedField(
      t("stats.fieldAnalysisWindow", "Analysis ({window})", { window: windowLabel(days, t) }),
      trimLines(
        t(
          "stats.channelAnalysisBody",
          "Messages: `{total}` (avg `{average}`/day)\nActive days: `{activeDays}/{windowSpan}`\nPeak day: {peakDate} · `{peakValue}` msgs\nShare of server traffic: `{sharePct}`\nBusiest weekday: **{busiestWeekday}**\nTrend: {trend}",
          {
            total: analysis.total.toLocaleString(),
            average: analysis.average.toFixed(1),
            activeDays: analysis.activeDays,
            windowSpan: windowSpan(days, daily.length, t),
            peakDate: formatStatDate(dates[analysis.peakIndex]),
            peakValue: analysis.peakValue.toLocaleString(),
            sharePct: pct(channelMessagesInWindow, serverTrafficTotal),
            busiestWeekday: weekdayName(analysis.busiestWeekday, t),
            trend: formatTrend(analysis.trend, analysis.trendPct, t),
          },
        ),
      ),
    ),
  ];
}

async function buildCategoryFields(state: StatsState, guild: Guild, caption: string, t: Translator) {
  if (state.category === "home") return buildHomeFields(state, guild, t);

  if (state.scope.type === "server" && state.category === "leaders") {
    return [];
  }

  let values: number[] = [];
  let dates: string[] = [];
  if (state.scope.type === "server") {
    const daily = await getFilledDailyStats(guild.id, state.days);
    values = daily.map((r) => {
      if (state.category === "membership") return r.joins + r.leaves;
      if (state.category === "engagement") return r.edits + r.deletes + r.reactions + r.attachments;
      return r.messages;
    });
    dates = daily.map((r) => r.statDate);
  } else if (state.scope.type === "user") {
    const daily = await getFilledUserDailyStats(guild.id, state.scope.userId, state.days);
    values = daily.map((r) => r.messages);
    dates = daily.map((r) => r.statDate);
  } else {
    const daily = await getFilledChannelDailyStats(guild.id, state.scope.channelId, state.days);
    values = daily.map((r) => r.messages);
    dates = daily.map((r) => r.statDate);
  }

  const analysis = analyzeSeries(values, dates);
  return [
    embedField(t("stats.fieldChart", "Chart"), caption),
    embedField(
      t("stats.fieldSummaryWindow", "Summary ({window})", { window: windowLabel(state.days, t) }),
      trimLines(
        t(
          "stats.categorySummaryBody",
          "Total: `{total}`\nAverage: `{average}`/day\nPeak: {peakDate} · `{peakValue}`\nActive days: `{activeDays}/{windowSpan}`\nBusiest weekday: **{busiestWeekday}**\nTrend: {trend}",
          {
            total: analysis.total.toLocaleString(),
            average: analysis.average.toFixed(1),
            peakDate: formatStatDate(dates[analysis.peakIndex]),
            peakValue: analysis.peakValue.toLocaleString(),
            activeDays: analysis.activeDays,
            windowSpan: windowSpan(state.days, dates.length, t),
            busiestWeekday: weekdayName(analysis.busiestWeekday, t),
            trend: formatTrend(analysis.trend, analysis.trendPct, t),
          },
        ),
      ),
    ),
  ];
}

function buildNavRow(state: StatsState, t: Translator): ActionRowBuilder<ButtonBuilder> {
  const cat = categoryDef(state.scope, state.category, t);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId("go", { ...state, category: "home", chartPage: 0 }))
      .setLabel(t("stats.navHome", "Home"))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(state.category === "home"),
  );

  if (cat.charts > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId("prev", { ...state, chartPage: Math.max(0, state.chartPage - 1) }))
        .setLabel(t("stats.navPreviousChart", "Previous chart"))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.chartPage <= 0),
      new ButtonBuilder()
        .setCustomId(buildCustomId("next", { ...state, chartPage: Math.min(cat.charts - 1, state.chartPage + 1) }))
        .setLabel(t("stats.navNextChart", "Next chart"))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.chartPage >= cat.charts - 1),
    );
  }

  return row;
}

function buildCategorySelect(state: StatsState, t: Translator): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId("cat", state))
      .setPlaceholder(t("stats.categorySelectPlaceholder", "Browse data categories…"))
      .addOptions(
        categoriesFor(state.scope, t).map((cat) => ({
          label: cat.label,
          description: cat.description.slice(0, 100),
          value: cat.id,
          default: state.category === cat.id,
        })),
      ),
  );
}

function statsWindowOptions(t: Translator): { days: StatsWindow; label: string; description: string }[] {
  return [
    { days: 7, label: t("stats.window7Days", "7 days"), description: t("stats.window7DaysDesc", "Analyze the last 7 UTC days") },
    { days: 14, label: t("stats.window14Days", "14 days"), description: t("stats.window14DaysDesc", "Analyze the last 14 UTC days") },
    { days: 30, label: t("stats.window30Days", "30 days"), description: t("stats.window30DaysDesc", "Analyze the last 30 UTC days") },
    { days: 0, label: t("stats.windowAllTime", "All time"), description: t("stats.windowAllTimeDesc", "Every recorded day since tracking began") },
  ];
}

function buildDaysSelect(state: StatsState, t: Translator): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId("days", state))
      .setPlaceholder(t("stats.daysSelectPlaceholder", "Select time window…"))
      .addOptions(
        statsWindowOptions(t).map(({ days, label, description }) => ({
          label,
          description,
          value: String(days),
          default: state.days === days,
        })),
      ),
  );
}

export async function buildStatsPayload(
  state: StatsState,
  guild: Guild,
  client: Client,
  guildConfig: GuildConfig,
  t: Translator = defaultTranslator,
): Promise<{ embed: ResultContainer; files: AttachmentBuilder[]; rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] }> {
  const cat = categoryDef(state.scope, state.category, t);
  const chartPage = Math.min(Math.max(0, state.chartPage), Math.max(0, cat.charts - 1));
  const normalized: StatsState = { ...state, chartPage };

  let chartBuffer: Buffer | null = null;
  let caption = "";
  if (cat.charts > 0) {
    const chart = await renderStatsChart(normalized, guild, t);
    chartBuffer = chart.buffer;
    caption = chart.caption;
  }

  const fields = await buildCategoryFields(normalized, guild, caption, t);
  if (state.scope.type === "server") {
    const serverLb = publicLeaderboardUrl(guild.id);
    const links = [
      serverLb ? t("stats.publicLeaderboardLink", "[Public leaderboard]({url})", { url: serverLb }) : null,
      t("stats.globalLeaderboardLink", "[Global leaderboard]({url})", { url: getGlobalLeaderboardUrl() }),
    ]
      .filter(Boolean)
      .join(" · ");
    fields.push(embedField("​", links));
  }

  let thumbnailURL: string | null = null;
  if (state.scope.type === "server") thumbnailURL = guild.iconURL({ size: 128 });
  if (state.scope.type === "user") {
    thumbnailURL = (await guild.members.fetch(state.scope.userId).catch(() => null))?.displayAvatarURL({ size: 128 }) ?? null;
  }

  const embed = setEmbedAuthor(
    baseEmbed(),
    scopeTitle(state.scope, guild, t),
    client,
    commandHeader(guildConfig, { thumbnailURL, emoji: scopeEmoji(state.scope) }),
  )
    .addFields(fields)
    .setFooter({
      text:
        cat.charts > 0
          ? t("stats.footerWithChart", "{category} · Chart {page}/{total} · {window} window · UTC days", {
              category: cat.label,
              page: chartPage + 1,
              total: cat.charts,
              window: formatStatsWindowLabel(normalized.days, t),
            })
          : t("stats.footerNoChart", "{category} · {window} window · Pick a category below", {
              category: cat.label,
              window: formatStatsWindowLabel(normalized.days, t),
            }),
    });

  if (chartBuffer) embed.setImage("attachment://chart.png");

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    buildNavRow(normalized, t),
    buildCategorySelect(normalized, t),
    buildDaysSelect(normalized, t),
  ];

  return {
    embed,
    files: chartBuffer ? [new AttachmentBuilder(chartBuffer, { name: "chart.png" })] : [],
    rows,
  };
}
