import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type APIEmbed,
  type Client,
  type Guild,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { GuildConfig } from "../../../../config/schemas/guild.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../../core/embeds.js";
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

function windowLabel(days: StatsWindow): string {
  return formatStatsWindowLong(days);
}

function windowSpan(days: StatsWindow, recordedDays: number): string {
  if (isAllTimeWindow(days)) return `${recordedDays} recorded days`;
  return String(days);
}

function statDateTimestamp(statDate: string): number {
  return Math.floor(Date.parse(`${statDate}T12:00:00Z`) / 1000);
}

function formatStatDate(statDate: string | undefined): string {
  if (!statDate) return "—";
  return `<t:${statDateTimestamp(statDate)}:D>`;
}

function scopeTitle(scope: StatsState["scope"], guild: Guild): string {
  if (scope.type === "server") return `${guild.name} stats`;
  if (scope.type === "user") return "User stats";
  return "Channel stats";
}

async function buildHomeFields(state: StatsState, guild: Guild) {
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
        "Overview",
        trimLines(`
          Lifetime tracked messages: \`${totalMessages.toLocaleString()}\`
          Active messagers: \`${activeUsers.toLocaleString()}\`
          All-time daily totals: \`${totals.messages.toLocaleString()}\` msgs · \`${totals.joins}\` joins · \`${totals.leaves}\` leaves
        `),
      ),
      embedField(
        `Analysis (${windowLabel(days)})`,
        trimLines(`
          Messages: \`${msgAnalysis.total.toLocaleString()}\` (avg \`${msgAnalysis.average.toFixed(1)}\`/day)
          Joins / leaves: \`${joinAnalysis.total}\` / \`${leaveAnalysis.total}\` (net \`${netMembers >= 0 ? "+" : ""}${netMembers}\`)
          Peak day: ${formatStatDate(dates[msgAnalysis.peakIndex])} · \`${msgAnalysis.peakValue.toLocaleString()}\` msgs
          Busiest weekday: **${weekdayName(msgAnalysis.busiestWeekday)}**
          Trend: ${formatTrend(msgAnalysis.trend, msgAnalysis.trendPct)}
        `),
      ),
      embedField(
        "Engagement totals",
        trimLines(`
          Edits: \`${totals.edits.toLocaleString()}\`
          Deletes: \`${totals.deletes.toLocaleString()}\`
          Reactions: \`${totals.reactions.toLocaleString()}\`
          Attachments: \`${totals.attachments.toLocaleString()}\`
        `),
      ),
      embedField(
        `Top messagers (${windowLabel(days)})`,
        topRecent.length
          ? topRecent.map((e, i) => `${i + 1}. <@${e.userId}> · \`${e.count.toLocaleString()}\``).join("\n")
          : "No recent daily message data yet.",
        true,
      ),
      embedField(
        "Top messagers (all-time)",
        topAllTime.length
          ? topAllTime.map((e, i) => `${i + 1}. <@${e.userId}> · \`${e.count.toLocaleString()}\``).join("\n")
          : "No message data yet.",
        true,
      ),
      embedField(
        `Top channels (${windowLabel(days)})`,
        topChannels.length
          ? topChannels.map((e, i) => `${i + 1}. <#${e.channelId}> · \`${e.count.toLocaleString()}\``).join("\n")
          : "No channel activity recorded yet.",
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
      embedField("User", user ? `<@${user.id}> (\`${user.tag}\`)` : `<@${userId}>`),
      embedField(
        "Lifetime totals",
        trimLines(`
          This server: \`${guildCount.toLocaleString()}\` (${pct(guildCount, serverTotal)} of tracked traffic)
          All servers: \`${globalCount.toLocaleString()}\`
          Rank here: \`#${rank || "—"}\` of \`${activeUsers.toLocaleString()}\` active messagers
        `),
      ),
      embedField(
        `Analysis (${windowLabel(days)})`,
        trimLines(`
          Messages: \`${analysis.total.toLocaleString()}\` (avg \`${analysis.average.toFixed(1)}\`/day)
          Active days: \`${analysis.activeDays}/${windowSpan(days, daily.length)}\`
          Peak day: ${formatStatDate(dates[analysis.peakIndex])} · \`${analysis.peakValue.toLocaleString()}\` msgs
          Share of server traffic: \`${pct(userMessagesInWindow, serverTrafficTotal)}\`
          Busiest weekday: **${weekdayName(analysis.busiestWeekday)}**
          Trend: ${formatTrend(analysis.trend, analysis.trendPct)}
        `),
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
      : "Unknown";

  return [
    embedField("Channel", channel && "name" in channel ? `<#${channel.id}> (\`${channel.name}\`)` : `<#${channelId}>`),
    embedField(
      "Overview",
      trimLines(`
        Created: ${created}
        Tracked by stats: \`${lifetimeDaily.toLocaleString()}\` msgs
        Currently retained in logs: \`${trackedLogs.toLocaleString()}\`
      `),
    ),
    embedField(
      `Analysis (${windowLabel(days)})`,
      trimLines(`
        Messages: \`${analysis.total.toLocaleString()}\` (avg \`${analysis.average.toFixed(1)}\`/day)
        Active days: \`${analysis.activeDays}/${windowSpan(days, daily.length)}\`
        Peak day: ${formatStatDate(dates[analysis.peakIndex])} · \`${analysis.peakValue.toLocaleString()}\` msgs
        Share of server traffic: \`${pct(channelMessagesInWindow, serverTrafficTotal)}\`
        Busiest weekday: **${weekdayName(analysis.busiestWeekday)}**
        Trend: ${formatTrend(analysis.trend, analysis.trendPct)}
      `),
    ),
  ];
}

async function buildCategoryFields(state: StatsState, guild: Guild, caption: string) {
  if (state.category === "home") return buildHomeFields(state, guild);

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
    embedField("Chart", caption),
    embedField(
      `Summary (${windowLabel(state.days)})`,
        trimLines(`
        Total: \`${analysis.total.toLocaleString()}\`
        Average: \`${analysis.average.toFixed(1)}\`/day
        Peak: ${formatStatDate(dates[analysis.peakIndex])} · \`${analysis.peakValue.toLocaleString()}\`
        Active days: \`${analysis.activeDays}/${windowSpan(state.days, dates.length)}\`
        Busiest weekday: **${weekdayName(analysis.busiestWeekday)}**
        Trend: ${formatTrend(analysis.trend, analysis.trendPct)}
      `),
    ),
  ];
}

function buildNavRow(state: StatsState): ActionRowBuilder<ButtonBuilder> {
  const cat = categoryDef(state.scope, state.category);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId("go", { ...state, category: "home", chartPage: 0 }))
      .setLabel("Home")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(state.category === "home"),
  );

  if (cat.charts > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId("prev", { ...state, chartPage: Math.max(0, state.chartPage - 1) }))
        .setLabel("Previous chart")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.chartPage <= 0),
      new ButtonBuilder()
        .setCustomId(buildCustomId("next", { ...state, chartPage: Math.min(cat.charts - 1, state.chartPage + 1) }))
        .setLabel("Next chart")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.chartPage >= cat.charts - 1),
    );
  }

  return row;
}

function buildCategorySelect(state: StatsState): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId("cat", state))
      .setPlaceholder("Browse data categories…")
      .addOptions(
        categoriesFor(state.scope).map((cat) => ({
          label: cat.label,
          description: cat.description.slice(0, 100),
          value: cat.id,
          default: state.category === cat.id,
        })),
      ),
  );
}

const STATS_WINDOW_OPTIONS: { days: StatsWindow; label: string; description: string }[] = [
  { days: 7, label: "7 days", description: "Analyze the last 7 UTC days" },
  { days: 14, label: "14 days", description: "Analyze the last 14 UTC days" },
  { days: 30, label: "30 days", description: "Analyze the last 30 UTC days" },
  { days: 0, label: "All time", description: "Every recorded day since tracking began" },
];

function buildDaysSelect(state: StatsState): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId("days", state))
      .setPlaceholder("Select time window…")
      .addOptions(
        STATS_WINDOW_OPTIONS.map(({ days, label, description }) => ({
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
): Promise<{ embeds: APIEmbed[]; files: AttachmentBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] }> {
  const cat = categoryDef(state.scope, state.category);
  const chartPage = Math.min(Math.max(0, state.chartPage), Math.max(0, cat.charts - 1));
  const normalized: StatsState = { ...state, chartPage };

  let chartBuffer: Buffer | null = null;
  let caption = "";
  if (cat.charts > 0) {
    const chart = await renderStatsChart(normalized, guild);
    chartBuffer = chart.buffer;
    caption = chart.caption;
  }

  const fields = await buildCategoryFields(normalized, guild, caption);
  let thumbnailURL: string | null = null;
  if (state.scope.type === "server") thumbnailURL = guild.iconURL({ size: 128 });
  if (state.scope.type === "user") {
    thumbnailURL = (await guild.members.fetch(state.scope.userId).catch(() => null))?.displayAvatarURL({ size: 128 }) ?? null;
  }

  const embed = setEmbedAuthor(baseEmbed(), scopeTitle(state.scope, guild), client, commandHeader(guildConfig, { thumbnailURL }))
    .addFields(fields)
    .setFooter({
      text:
        cat.charts > 0
          ? `${cat.label} · Chart ${chartPage + 1}/${cat.charts} · ${formatStatsWindowLabel(normalized.days)} window · UTC days`
          : `${cat.label} · ${formatStatsWindowLabel(normalized.days)} window · Pick a category below`,
    });

  if (chartBuffer) embed.setImage("attachment://chart.png");

  return {
    embeds: [embed.toJSON()],
    files: chartBuffer ? [new AttachmentBuilder(chartBuffer, { name: "chart.png" })] : [],
    components: [buildNavRow(normalized), buildCategorySelect(normalized), buildDaysSelect(normalized)],
  };
}
