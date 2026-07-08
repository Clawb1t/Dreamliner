import { SlashCommandBuilder, ChannelType } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { getGuildMessageCount, getGlobalMessageCount } from "../../utility/functions/messageCounts.js";
import { getDailyTotals, getRecentDailyStats } from "../functions/daily.js";
import { getChannelTrackedMessages, getTopMessagers, getTotalGuildMessages } from "../functions/queries.js";

function statDateTimestamp(statDate: string): number {
  return Math.floor(Date.parse(`${statDate}T12:00:00Z`) / 1000);
}

function formatDailyRows(rows: Awaited<ReturnType<typeof getRecentDailyStats>>): string {
  if (!rows.length) return "No daily stats recorded yet.";
  return rows
    .map(
      (row) =>
        `<t:${statDateTimestamp(row.statDate)}:D>: **${row.messages}** msgs · **${row.joins}** joins · **${row.leaves}** leaves`,
    )
    .join("\n");
}

export const statsCommands: SlashCommandDefinition[] = [
  {
    plugin: "stats",
    data: new SlashCommandBuilder()
      .setName("stats")
      .setDescription("View server, user, or channel statistics")
      .addSubcommand((sub) => sub.setName("server").setDescription("Server activity statistics"))
      .addSubcommand((sub) =>
        sub
          .setName("user")
          .setDescription("Message statistics for a user")
          .addUserOption((o) => o.setName("user").setDescription("User to inspect")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("channel")
          .setDescription("Statistics for a channel")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Channel to inspect").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "server") {
        const auth = await requirePluginPermission(ctx, "stats", "can_server");
        if (!auth) return;

        const [daily, totals, totalMessages, top] = await Promise.all([
          getRecentDailyStats(guildId),
          getDailyTotals(guildId),
          getTotalGuildMessages(guildId),
          getTopMessagers(guildId),
        ]);

        const topLines = top.length
          ? top.map((entry, i) => `${i + 1}. <@${entry.userId}> · **${entry.count.toLocaleString()}**`).join("\n")
          : "No message data yet.";

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Server stats", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField(
                "Overview",
                trimLines(`
                  Tracked messages: **${totalMessages.toLocaleString()}**
                  Daily totals: **${totals.messages.toLocaleString()}** msgs · **${totals.joins}** joins · **${totals.leaves}** leaves
                `),
              ),
              embedField("Last 7 days", trimLines(formatDailyRows(daily))),
              embedField("Top messagers", trimLines(topLines)),
            ),
            ctx.ephemeral,
          ),
        );
        return;
      }

      if (sub === "user") {
        const auth = await requirePluginPermission(ctx, "stats", "can_user");
        if (!auth) return;

        const user = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
        const [guildCount, globalCount] = await Promise.all([
          getGuildMessageCount(guildId, user.id),
          getGlobalMessageCount(user.id),
        ]);

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "User stats", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("User", `<@${user.id}>`),
              embedField(
                "Messages",
                trimLines(`
                  This server: **${guildCount.toLocaleString()}**
                  All servers: **${globalCount.toLocaleString()}**
                `),
              ),
            ),
            ctx.ephemeral,
          ),
        );
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
            resultReply("Stats", "Could not resolve a text channel.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const tracked = await getChannelTrackedMessages(guildId, channel.id);
        const created = "createdTimestamp" in channel && channel.createdTimestamp ? `<t:${Math.floor(channel.createdTimestamp / 1000)}:R>` : "Unknown";

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Channel stats", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("Channel", `<#${channel.id}> (\`${channel.name}\`)`),
              embedField(
                "Details",
                trimLines(`
                  Created: ${created}
                  Tracked messages (logs): **${tracked.toLocaleString()}**
                `),
              ),
            ),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
