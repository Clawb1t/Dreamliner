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

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function renderStatsChart(
  state: StatsState,
  guild: Guild,
): Promise<{ buffer: Buffer | null; caption: string }> {
  const guildId = guild.id;
  const { days, category, chartPage } = state;

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
          buffer: await renderActivityChart({ labels, series: [{ label: "Messages", color: "#5865F2", values: messages }], mode: "line" }),
          caption: "Daily messages · line chart",
        };
      }
      if (chartPage === 1) {
        return {
          buffer: await renderActivityChart({ labels, series: [{ label: "Messages", color: "#5865F2", values: messages }], mode: "bar" }),
          caption: "Daily messages · bar chart",
        };
      }
      return {
        buffer: await renderWeekdayChart(WEEKDAY_LABELS, analyzeSeries(messages, dates).weekdayTotals),
        caption: "Messages by weekday",
      };
    }

    if (category === "membership") {
      const activeUsers = await getFilledDailyActiveUsers(guildId, days);
      if (chartPage === 0) {
        return {
          buffer: await renderActivityChart({
            labels,
            series: [
              { label: "Joins", color: "#3BA55D", values: joins },
              { label: "Leaves", color: "#ED4245", values: leaves },
            ],
            mode: "line",
          }),
          caption: "Joins and leaves · line chart",
        };
      }
      if (chartPage === 1) {
        const net = joins.map((j, i) => j - (leaves[i] ?? 0));
        return {
          buffer: await renderActivityChart({ labels, series: [{ label: "Net change", color: "#FEE75C", values: net }], mode: "bar" }),
          caption: "Net membership change per day",
        };
      }
      return {
        buffer: await renderActivityChart({
          labels: activeUsers.map((r) => shortDateLabel(r.statDate)),
          series: [{ label: "Active users", color: "#EB459E", values: activeUsers.map((r) => r.count) }],
          mode: "line",
        }),
        caption: "Unique messagers per day",
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
              { label: "Edits", color: "#FEE75C", values: edits },
              { label: "Deletes", color: "#ED4245", values: deletes },
              { label: "Reactions", color: "#EB459E", values: reactions },
            ],
            mode: "line",
          }),
          caption: "Engagement signals over time",
        };
      }
      if (chartPage === 1) {
        return {
          buffer: await renderActivityChart({ labels, series: [{ label: "Attachments", color: "#57F287", values: attachments }], mode: "bar" }),
          caption: "Attachments sent per day",
        };
      }
      return {
        buffer: await renderPieChart([
          { label: "Edits", value: edits.reduce((s, v) => s + v, 0), color: "#FEE75C" },
          { label: "Deletes", value: deletes.reduce((s, v) => s + v, 0), color: "#ED4245" },
          { label: "Reactions", value: reactions.reduce((s, v) => s + v, 0), color: "#EB459E" },
          { label: "Attachments", value: attachments.reduce((s, v) => s + v, 0), color: "#57F287" },
        ]),
        caption: "Engagement mix in this window",
      };
    }

    if (category === "leaders") {
      const guildName = guild.name;
      const windowLabel = formatStatsWindowLong(days).toLowerCase();
      if (chartPage === 0) {
        const result = await renderUsersLeaderboard(
          guild,
          days,
          "Top messagers",
          `${guildName} · ${windowLabel} · UTC`,
        );
        return { buffer: result.buffer, caption: result.caption };
      }
      if (chartPage === 1) {
        const result = await renderChannelsLeaderboard(
          guild,
          days,
          "Top channels",
          `${guildName} · ${windowLabel} · UTC`,
        );
        return { buffer: result.buffer, caption: result.caption };
      }
      const result = await renderAllTimeUsersLeaderboard(
        guild,
        "All-time messagers",
        `${guildName} · lifetime tracked messages`,
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
        return { buffer: await renderActivityChart({ labels: userLabels, series: [{ label: "Messages", color: "#5865F2", values }], mode: "bar" }), caption: "Daily messages · bar chart" };
      }
      if (chartPage === 1) {
        return { buffer: await renderActivityChart({ labels: userLabels, series: [{ label: "Messages", color: "#5865F2", values }], mode: "line" }), caption: "Daily messages · line chart" };
      }
      return { buffer: await renderWeekdayChart(WEEKDAY_LABELS, analyzeSeries(values, userDates).weekdayTotals), caption: "Messages by weekday" };
    }

    if (category === "patterns") {
      const analysis = analyzeSeries(values, userDates);
      const serverDaily = await getFilledDailyStats(guildId, days);
      if (chartPage === 0) {
        return { buffer: await renderWeekdayChart(WEEKDAY_LABELS, analysis.weekdayTotals, "#EB459E"), caption: "Weekday activity distribution" };
      }
      const serverWindow = serverDaily.reduce((sum, row) => sum + row.messages, 0);
      return {
        buffer: await renderPieChart([
          { label: "This user", value: analysis.total, color: "#5865F2" },
          { label: "Everyone else", value: Math.max(0, serverWindow - analysis.total), color: "#4E5058" },
        ]),
        caption: "Share of server messages in this window",
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
        return { buffer: await renderActivityChart({ labels: channelLabels, series: [{ label: "Messages", color: "#57F287", values }], mode: "bar" }), caption: "Daily messages · bar chart" };
      }
      if (chartPage === 1) {
        return { buffer: await renderActivityChart({ labels: channelLabels, series: [{ label: "Messages", color: "#57F287", values }], mode: "line" }), caption: "Daily messages · line chart" };
      }
      return { buffer: await renderWeekdayChart(WEEKDAY_LABELS, analyzeSeries(values, channelDates).weekdayTotals, "#57F287"), caption: "Messages by weekday" };
    }

    if (category === "patterns") {
      const analysis = analyzeSeries(values, channelDates);
      const serverDaily = await getFilledDailyStats(guildId, days);
      if (chartPage === 0) {
        return { buffer: await renderWeekdayChart(WEEKDAY_LABELS, analysis.weekdayTotals, "#57F287"), caption: "Weekday activity distribution" };
      }
      const serverWindow = serverDaily.reduce((sum, row) => sum + row.messages, 0);
      return {
        buffer: await renderPieChart([
          { label: "This channel", value: analysis.total, color: "#57F287" },
          { label: "Other channels", value: Math.max(0, serverWindow - analysis.total), color: "#4E5058" },
        ]),
        caption: "Share of server messages in this window",
      };
    }
  }

  return { buffer: null, caption: "" };
}
