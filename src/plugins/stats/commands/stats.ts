import {
  AttachmentBuilder,
  ChannelType,
  SlashCommandBuilder,
  SlashCommandIntegerOption,
} from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import {
  deferReplyOptions,
  embedWithFilesEdit,
  resultReply,
  slashResultOptions,
} from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { getGuildMessageCount, getGlobalMessageCount } from "../../utility/functions/messageCounts.js";
import {
  getFilledChannelDailyStats,
  getFilledDailyStats,
  getFilledUserDailyStats,
  getDailyTotals,
  shortDateLabel,
} from "../functions/daily.js";
import { renderActivityChart } from "../functions/charts.js";
import { analyzeSeries, formatTrend, pct, weekdayName } from "../functions/analysis.js";
import {
  getActiveMessagerCount,
  getChannelDailyTotal,
  getChannelTrackedMessages,
  getTopChannelsByDaily,
  getTopMessagers,
  getTopUsersByDaily,
  getTotalGuildMessages,
  getUserMessageRank,
} from "../functions/queries.js";

function daysOption(): SlashCommandIntegerOption {
  return new SlashCommandIntegerOption()
    .setName("days")
    .setDescription("How many days of activity to analyze")
    .addChoices(
      { name: "7 days", value: 7 },
      { name: "14 days", value: 14 },
      { name: "30 days", value: 30 },
    );
}

function resolveDays(raw: number | null): number {
  if (raw === 7 || raw === 30) return raw;
  return 14;
}

function statDateTimestamp(statDate: string): number {
  return Math.floor(Date.parse(`${statDate}T12:00:00Z`) / 1000);
}

function formatStatDate(statDate: string | undefined): string {
  if (!statDate) return "—";
  return `<t:${statDateTimestamp(statDate)}:D>`;
}

/** Newest-first daily totals, matching the original stats layout. */
function formatServerDailyRows(
  rows: { statDate: string; messages: number; joins: number; leaves: number }[],
  limit = 7,
): string {
  const recent = [...rows].slice(-limit).reverse();
  if (!recent.length) return "No daily stats recorded yet.";
  return recent
    .map(
      (row) =>
        `<t:${statDateTimestamp(row.statDate)}:D>: **${row.messages}** msgs · **${row.joins}** joins · **${row.leaves}** leaves`,
    )
    .join("\n");
}

function formatMessageDailyRows(rows: { statDate: string; messages: number }[], limit = 7): string {
  const recent = [...rows].slice(-limit).reverse();
  if (!recent.length) return "No daily stats recorded yet.";
  return recent
    .map((row) => `<t:${statDateTimestamp(row.statDate)}:D>: **${row.messages.toLocaleString()}** msgs`)
    .join("\n");
}

export const statsCommands: SlashCommandDefinition[] = [
  {
    plugin: "stats",
    data: new SlashCommandBuilder()
      .setName("stats")
      .setDescription("View detailed activity statistics and graphs")
      .addSubcommand((sub) =>
        sub.setName("server").setDescription("Server activity statistics with graphs").addIntegerOption(daysOption()),
      )
      .addSubcommand((sub) =>
        sub
          .setName("user")
          .setDescription("User activity statistics with graphs")
          .addUserOption((o) => o.setName("user").setDescription("User to inspect"))
          .addIntegerOption(daysOption()),
      )
      .addSubcommand((sub) =>
        sub
          .setName("channel")
          .setDescription("Channel activity statistics with graphs")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel to inspect")
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.PublicThread,
                ChannelType.PrivateThread,
              ),
          )
          .addIntegerOption(daysOption()),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const days = resolveDays(ctx.interaction.options.getInteger("days"));

      if (sub === "server") {
        const auth = await requirePluginPermission(ctx, "stats", "can_server");
        if (!auth) return;

        await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

        const [daily, totals, totalMessages, topAllTime, topRecent, topChannels, activeUsers] = await Promise.all([
          getFilledDailyStats(guildId, days),
          getDailyTotals(guildId),
          getTotalGuildMessages(guildId),
          getTopMessagers(guildId, 5),
          getTopUsersByDaily(guildId, days, 5),
          getTopChannelsByDaily(guildId, days, 5),
          getActiveMessagerCount(guildId),
        ]);

        const dates = daily.map((row) => row.statDate);
        const messages = daily.map((row) => row.messages);
        const joins = daily.map((row) => row.joins);
        const leaves = daily.map((row) => row.leaves);
        const msgAnalysis = analyzeSeries(messages, dates);
        const joinAnalysis = analyzeSeries(joins, dates);
        const leaveAnalysis = analyzeSeries(leaves, dates);
        const netMembers = joinAnalysis.total - leaveAnalysis.total;
        const chart = await renderActivityChart({
          title: `${ctx.interaction.guild!.name} · Activity`,
          subtitle: `Last ${days} days · UTC days`,
          labels: dates.map(shortDateLabel),
          series: [
            { label: "Messages", color: "#5865F2", values: messages },
            { label: "Joins", color: "#3BA55D", values: joins },
            { label: "Leaves", color: "#ED4245", values: leaves },
          ],
          mode: "line",
        });

        const file = new AttachmentBuilder(chart, { name: "activity.png" });
        const topRecentLines = topRecent.length
          ? topRecent.map((entry, i) => `${i + 1}. <@${entry.userId}> · **${entry.count.toLocaleString()}**`).join("\n")
          : "No recent daily message data yet.";
        const topAllTimeLines = topAllTime.length
          ? topAllTime.map((entry, i) => `${i + 1}. <@${entry.userId}> · **${entry.count.toLocaleString()}**`).join("\n")
          : "No message data yet.";
        const topChannelLines = topChannels.length
          ? topChannels.map((entry, i) => `${i + 1}. <#${entry.channelId}> · **${entry.count.toLocaleString()}**`).join("\n")
          : "No channel activity recorded yet.";

        const embed = setEmbedAuthor(
          baseEmbed().setImage("attachment://activity.png"),
          "Server stats",
          ctx.client,
          commandHeader(ctx.guildConfig, { thumbnailURL: ctx.interaction.guild!.iconURL({ size: 128 }) }),
        ).addFields(
          embedField(
            "Overview",
            trimLines(`
              Lifetime tracked messages: **${totalMessages.toLocaleString()}**
              Active messagers: **${activeUsers.toLocaleString()}**
              All-time daily totals: **${totals.messages.toLocaleString()}** msgs · **${totals.joins}** joins · **${totals.leaves}** leaves
            `),
          ),
          embedField(
            `Analysis (${days}d)`,
            trimLines(`
              Messages: **${msgAnalysis.total.toLocaleString()}** (avg **${msgAnalysis.average.toFixed(1)}**/day)
              Joins / leaves: **${joinAnalysis.total}** / **${leaveAnalysis.total}** (net **${netMembers >= 0 ? "+" : ""}${netMembers}**)
              Active days: **${msgAnalysis.activeDays}/${days}**
              Peak day: ${formatStatDate(dates[msgAnalysis.peakIndex])} · **${msgAnalysis.peakValue.toLocaleString()}** msgs
              Busiest weekday: **${weekdayName(msgAnalysis.busiestWeekday)}**
              Trend: ${formatTrend(msgAnalysis.trend, msgAnalysis.trendPct)}
            `),
          ),
          embedField("Last 7 days", trimLines(formatServerDailyRows(daily, 7))),
          embedField(`Top messagers (${days}d)`, trimLines(topRecentLines), true),
          embedField("Top messagers (all-time)", trimLines(topAllTimeLines), true),
          embedField(`Top channels (${days}d)`, trimLines(topChannelLines)),
        );

        await ctx.interaction.editReply(embedWithFilesEdit(embed, [file]));
        return;
      }

      if (sub === "user") {
        const auth = await requirePluginPermission(ctx, "stats", "can_user");
        if (!auth) return;

        await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

        const user = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
        const [guildCount, globalCount, daily, serverTotal, activeUsers, serverDaily] = await Promise.all([
          getGuildMessageCount(guildId, user.id),
          getGlobalMessageCount(user.id),
          getFilledUserDailyStats(guildId, user.id, days),
          getTotalGuildMessages(guildId),
          getActiveMessagerCount(guildId),
          getFilledDailyStats(guildId, days),
        ]);
        const rank = await getUserMessageRank(guildId, user.id, guildCount);

        const dates = daily.map((row) => row.statDate);
        const values = daily.map((row) => row.messages);
        const analysis = analyzeSeries(values, dates);
        const serverWindow = serverDaily.reduce((sum, row) => sum + row.messages, 0);
        const windowShare = pct(analysis.total, serverWindow);

        const chart = await renderActivityChart({
          title: `${user.username} · Messages`,
          subtitle: `Last ${days} days in ${ctx.interaction.guild!.name}`,
          labels: dates.map(shortDateLabel),
          series: [{ label: "Messages", color: "#5865F2", values }],
          mode: "bar",
        });
        const file = new AttachmentBuilder(chart, { name: "activity.png" });

        const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
        const embed = setEmbedAuthor(
          baseEmbed().setImage("attachment://activity.png"),
          "User stats",
          ctx.client,
          commandHeader(ctx.guildConfig, {
            thumbnailURL: (member ?? user).displayAvatarURL({ size: 128 }),
          }),
        ).addFields(
          embedField("User", `<@${user.id}> (\`${user.tag}\`)`),
          embedField(
            "Lifetime totals",
            trimLines(`
              This server: **${guildCount.toLocaleString()}** (${pct(guildCount, serverTotal)} of tracked traffic)
              All servers: **${globalCount.toLocaleString()}**
              Rank here: **#${rank || "—"}** of **${activeUsers.toLocaleString()}** active messagers
            `),
          ),
          embedField(
            `Analysis (${days}d)`,
            trimLines(`
              Messages: **${analysis.total.toLocaleString()}** (avg **${analysis.average.toFixed(1)}**/day)
              Active days: **${analysis.activeDays}/${days}**
              Peak day: ${formatStatDate(dates[analysis.peakIndex])} · **${analysis.peakValue.toLocaleString()}** msgs
              Share of server traffic: **${windowShare}**
              Busiest weekday: **${weekdayName(analysis.busiestWeekday)}**
              Trend: ${formatTrend(analysis.trend, analysis.trendPct)}
            `),
          ),
          embedField("Last 7 days", trimLines(formatMessageDailyRows(daily, 7))),
        );

        if (analysis.total === 0 && guildCount > 0) {
          embed.setFooter({
            text: "Daily user graphs start after this update — lifetime totals still include older activity.",
          });
        }

        await ctx.interaction.editReply(embedWithFilesEdit(embed, [file]));
        return;
      }

      if (sub === "channel") {
        const auth = await requirePluginPermission(ctx, "stats", "can_channel");
        if (!auth) return;

        const channel =
          ctx.interaction.options.getChannel("channel") ??
          (ctx.interaction.channel?.isTextBased() ? ctx.interaction.channel : null);
        if (!channel || !("name" in channel)) {
          await ctx.interaction.reply(
            resultReply("Stats", "Could not resolve a text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

        const [daily, trackedLogs, lifetimeDaily, serverDaily] = await Promise.all([
          getFilledChannelDailyStats(guildId, channel.id, days),
          getChannelTrackedMessages(guildId, channel.id),
          getChannelDailyTotal(guildId, channel.id),
          getFilledDailyStats(guildId, days),
        ]);

        const dates = daily.map((row) => row.statDate);
        const values = daily.map((row) => row.messages);
        const analysis = analyzeSeries(values, dates);
        const serverWindow = serverDaily.reduce((sum, row) => sum + row.messages, 0);
        const created =
          "createdTimestamp" in channel && channel.createdTimestamp
            ? `<t:${Math.floor(channel.createdTimestamp / 1000)}:R>`
            : "Unknown";

        const chart = await renderActivityChart({
          title: `#${channel.name} · Messages`,
          subtitle: `Last ${days} days`,
          labels: dates.map(shortDateLabel),
          series: [{ label: "Messages", color: "#57F287", values }],
          mode: "bar",
        });
        const file = new AttachmentBuilder(chart, { name: "activity.png" });

        const embed = setEmbedAuthor(
          baseEmbed().setImage("attachment://activity.png"),
          "Channel stats",
          ctx.client,
          commandHeader(ctx.guildConfig),
        ).addFields(
          embedField("Channel", `<#${channel.id}> (\`${channel.name}\`)`),
          embedField(
            "Overview",
            trimLines(`
              Created: ${created}
              Tracked by stats: **${lifetimeDaily.toLocaleString()}** msgs
              Currently retained in logs: **${trackedLogs.toLocaleString()}**
            `),
          ),
          embedField(
            `Analysis (${days}d)`,
            trimLines(`
              Messages: **${analysis.total.toLocaleString()}** (avg **${analysis.average.toFixed(1)}**/day)
              Active days: **${analysis.activeDays}/${days}**
              Peak day: ${formatStatDate(dates[analysis.peakIndex])} · **${analysis.peakValue.toLocaleString()}** msgs
              Share of server traffic: **${pct(analysis.total, serverWindow)}**
              Busiest weekday: **${weekdayName(analysis.busiestWeekday)}**
              Trend: ${formatTrend(analysis.trend, analysis.trendPct)}
            `),
          ),
          embedField("Last 7 days", trimLines(formatMessageDailyRows(daily, 7))),
        );

        if (analysis.total === 0 && trackedLogs > 0) {
          embed.setFooter({
            text: "Daily channel graphs start after this update — log retention is separate from activity charts.",
          });
        }

        await ctx.interaction.editReply(embedWithFilesEdit(embed, [file]));
      }
    },
  },
];
