import type { Guild } from "discord.js";
import { analyzeSeries } from "../analysis.js";
import {
  renderActivityChart,
  renderPieChart,
  renderWeekdayChart,
} from "../charts.js";
import { formatStatsWindowLong, getFilledChannelDailyStats, getFilledDailyStats, getFilledUserDailyStats, shortDateLabel } from "../daily.js";
import { getFilledDailyActiveUsers } from "../queries.js";
import {
  renderAllTimeUsersLeaderboard,
  renderChannelsLeaderboard,
  renderUsersLeaderboard,
} from "../leaderboard.js";
import type { StatsState } from "./state.js";
import { defaultTranslator, type Translator } from "../../../../i18n/index.js";

function weekdayLabels(t: Translator): string[] {
  return [
    t("stats.weekdaySun", "Sun"),
    t("stats.weekdayMon", "Mon"),
    t("stats.weekdayTue", "Tue"),
    t("stats.weekdayWed", "Wed"),
    t("stats.weekdayThu", "Thu"),
    t("stats.weekdayFri", "Fri"),
    t("stats.weekdaySat", "Sat"),
  ];
}

export async function renderStatsChart(
  state: StatsState,
  guild: Guild,
  t: Translator = defaultTranslator,
): Promise<{ buffer: Buffer | null; caption: string }> {
  const guildId = guild.id;
  const { days, category, chartPage } = state;
  const WEEKDAY_LABELS = weekdayLabels(t);

  if (state.scope.type === "server") {
    const daily = await getFilledDailyStats(guildId, days);
    const dates = daily.map((r) => r.statDate);
    const labels = dates.map(shortDateLabel);
    const messages = daily.map((r) => r.messages);
    const joins = daily.map((r) => r.joins);
    const leaves = daily.map((r) => r.leaves);

    if (category === "activity") {
      if (chartPage === 0) {
        return {
          buffer: await renderActivityChart({ labels, series: [{ label: t("stats.seriesMessages", "Messages"), color: "#5865F2", values: messages }], mode: "line" }),
          caption: t("stats.captionDailyMessagesBar", "Daily messages · line chart"),
        };
      }
      if (chartPage === 1) {
        return {
          buffer: await renderActivityChart({ labels, series: [{ label: t("stats.seriesMessages", "Messages"), color: "#5865F2", values: messages }], mode: "bar" }),
          caption: t("stats.captionDailyMessagesBarChart", "Daily messages · bar chart"),
        };
      }
      return {
        buffer: await renderWeekdayChart(WEEKDAY_LABELS, analyzeSeries(messages, dates).weekdayTotals, undefined, t),
        caption: t("stats.captionMessagesByWeekday", "Messages by weekday"),
      };
    }

    if (category === "membership") {
      const activeUsers = await getFilledDailyActiveUsers(guildId, days);
      if (chartPage === 0) {
        return {
          buffer: await renderActivityChart({
            labels,
            series: [
              { label: t("stats.seriesJoins", "Joins"), color: "#3BA55D", values: joins },
              { label: t("stats.seriesLeaves", "Leaves"), color: "#ED4245", values: leaves },
            ],
            mode: "line",
          }),
          caption: t("stats.captionJoinsLeavesLine", "Joins and leaves · line chart"),
        };
      }
      if (chartPage === 1) {
        const net = joins.map((j, i) => j - (leaves[i] ?? 0));
        return {
          buffer: await renderActivityChart({ labels, series: [{ label: t("stats.seriesNetChange", "Net change"), color: "#FEE75C", values: net }], mode: "bar" }),
          caption: t("stats.captionNetMembershipChange", "Net membership change per day"),
        };
      }
      return {
        buffer: await renderActivityChart({
          labels: activeUsers.map((r) => shortDateLabel(r.statDate)),
          series: [{ label: t("stats.seriesActiveUsers", "Active users"), color: "#EB459E", values: activeUsers.map((r) => r.count) }],
          mode: "line",
        }),
        caption: t("stats.captionUniqueMessagersPerDay", "Unique messagers per day"),
      };
    }

    if (category === "engagement") {
      const edits = daily.map((r) => r.edits);
      const deletes = daily.map((r) => r.deletes);
      const reactions = daily.map((r) => r.reactions);
      const attachments = daily.map((r) => r.attachments);
      if (chartPage === 0) {
        return {
          buffer: await renderActivityChart({
            labels,
            series: [
              { label: t("stats.seriesEdits", "Edits"), color: "#FEE75C", values: edits },
              { label: t("stats.seriesDeletes", "Deletes"), color: "#ED4245", values: deletes },
              { label: t("stats.seriesReactions", "Reactions"), color: "#EB459E", values: reactions },
            ],
            mode: "line",
          }),
          caption: t("stats.captionEngagementSignalsOverTime", "Engagement signals over time"),
        };
      }
      if (chartPage === 1) {
        return {
          buffer: await renderActivityChart({ labels, series: [{ label: t("stats.seriesAttachments", "Attachments"), color: "#57F287", values: attachments }], mode: "bar" }),
          caption: t("stats.captionAttachmentsSentPerDay", "Attachments sent per day"),
        };
      }
      return {
        buffer: await renderPieChart(
          [
            { label: t("stats.seriesEdits", "Edits"), value: edits.reduce((s, v) => s + v, 0), color: "#FEE75C" },
            { label: t("stats.seriesDeletes", "Deletes"), value: deletes.reduce((s, v) => s + v, 0), color: "#ED4245" },
            { label: t("stats.seriesReactions", "Reactions"), value: reactions.reduce((s, v) => s + v, 0), color: "#EB459E" },
            { label: t("stats.seriesAttachments", "Attachments"), value: attachments.reduce((s, v) => s + v, 0), color: "#57F287" },
          ],
          t,
        ),
        caption: t("stats.captionEngagementMixInWindow", "Engagement mix in this window"),
      };
    }

    if (category === "leaders") {
      const guildName = guild.name;
      const windowLabel = formatStatsWindowLong(days, t).toLowerCase();
      if (chartPage === 0) {
        const result = await renderUsersLeaderboard(
          guild,
          days,
          t("stats.leaderboardTopMessagers", "Top messagers"),
          `${guildName} · ${windowLabel} · UTC`,
          t,
        );
        return { buffer: result.buffer, caption: result.caption };
      }
      if (chartPage === 1) {
        const result = await renderChannelsLeaderboard(
          guild,
          days,
          t("stats.leaderboardTopChannels", "Top channels"),
          `${guildName} · ${windowLabel} · UTC`,
          t,
        );
        return { buffer: result.buffer, caption: result.caption };
      }
      const result = await renderAllTimeUsersLeaderboard(
        guild,
        t("stats.leaderboardAllTimeMessagers", "All-time messagers"),
        t("stats.leaderboardLifetimeTracked", "{guildName} · lifetime tracked messages", { guildName }),
        t,
      );
      return { buffer: result.buffer, caption: result.caption };
    }
  }

  if (state.scope.type === "user") {
    const daily = await getFilledUserDailyStats(guildId, state.scope.userId, days);
    const values = daily.map((r) => r.messages);
    const userDates = daily.map((r) => r.statDate);
    const userLabels = userDates.map(shortDateLabel);

    if (category === "activity") {
      if (chartPage === 0) {
        return { buffer: await renderActivityChart({ labels: userLabels, series: [{ label: t("stats.seriesMessages", "Messages"), color: "#5865F2", values }], mode: "bar" }), caption: t("stats.captionDailyMessagesBarChart", "Daily messages · bar chart") };
      }
      if (chartPage === 1) {
        return { buffer: await renderActivityChart({ labels: userLabels, series: [{ label: t("stats.seriesMessages", "Messages"), color: "#5865F2", values }], mode: "line" }), caption: t("stats.captionDailyMessagesBar", "Daily messages · line chart") };
      }
      return { buffer: await renderWeekdayChart(WEEKDAY_LABELS, analyzeSeries(values, userDates).weekdayTotals, undefined, t), caption: t("stats.captionMessagesByWeekday", "Messages by weekday") };
    }

    if (category === "patterns") {
      const analysis = analyzeSeries(values, userDates);
      const serverDaily = await getFilledDailyStats(guildId, days);
      if (chartPage === 0) {
        return { buffer: await renderWeekdayChart(WEEKDAY_LABELS, analysis.weekdayTotals, "#EB459E", t), caption: t("stats.captionWeekdayActivityDistribution", "Weekday activity distribution") };
      }
      const serverWindow = serverDaily.reduce((sum, row) => sum + row.messages, 0);
      return {
        buffer: await renderPieChart(
          [
            { label: t("stats.seriesThisUser", "This user"), value: analysis.total, color: "#5865F2" },
            { label: t("stats.seriesEveryoneElse", "Everyone else"), value: Math.max(0, serverWindow - analysis.total), color: "#4E5058" },
          ],
          t,
        ),
        caption: t("stats.captionShareOfServerMessages", "Share of server messages in this window"),
      };
    }
  }

  if (state.scope.type === "channel") {
    const daily = await getFilledChannelDailyStats(guildId, state.scope.channelId, days);
    const values = daily.map((r) => r.messages);
    const channelDates = daily.map((r) => r.statDate);
    const channelLabels = channelDates.map(shortDateLabel);

    if (category === "activity") {
      if (chartPage === 0) {
        return { buffer: await renderActivityChart({ labels: channelLabels, series: [{ label: t("stats.seriesMessages", "Messages"), color: "#57F287", values }], mode: "bar" }), caption: t("stats.captionDailyMessagesBarChart", "Daily messages · bar chart") };
      }
      if (chartPage === 1) {
        return { buffer: await renderActivityChart({ labels: channelLabels, series: [{ label: t("stats.seriesMessages", "Messages"), color: "#57F287", values }], mode: "line" }), caption: t("stats.captionDailyMessagesBar", "Daily messages · line chart") };
      }
      return { buffer: await renderWeekdayChart(WEEKDAY_LABELS, analyzeSeries(values, channelDates).weekdayTotals, "#57F287", t), caption: t("stats.captionMessagesByWeekday", "Messages by weekday") };
    }

    if (category === "patterns") {
      const analysis = analyzeSeries(values, channelDates);
      const serverDaily = await getFilledDailyStats(guildId, days);
      if (chartPage === 0) {
        return { buffer: await renderWeekdayChart(WEEKDAY_LABELS, analysis.weekdayTotals, "#57F287", t), caption: t("stats.captionWeekdayActivityDistribution", "Weekday activity distribution") };
      }
      const serverWindow = serverDaily.reduce((sum, row) => sum + row.messages, 0);
      return {
        buffer: await renderPieChart(
          [
            { label: t("stats.seriesThisChannel", "This channel"), value: analysis.total, color: "#57F287" },
            { label: t("stats.seriesOtherChannels", "Other channels"), value: Math.max(0, serverWindow - analysis.total), color: "#4E5058" },
          ],
          t,
        ),
        caption: t("stats.captionShareOfServerMessages", "Share of server messages in this window"),
      };
    }
  }

  return { buffer: null, caption: "" };
}
