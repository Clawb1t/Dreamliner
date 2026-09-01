import { AttachmentBuilder, ChannelType, SlashCommandBuilder, SlashCommandIntegerOption } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { deferReplyOptions, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { getGlobalLeaderboardUrl, getGuildStatsDashboardUrl } from "../../../core/docsUrl.js";
import { publicLeaderboardUrl } from "../../../core/publicLeaderboard.js";
import { ALL_TIME_WINDOW, isValidStatsWindow, type StatsWindow } from "../functions/daily.js";
import { buildStatsMessage, type StatsState } from "../functions/ui/index.js";
import { renderUserRankCard, type RankScope } from "../functions/rank.js";

function daysOption(): SlashCommandIntegerOption {
  return new SlashCommandIntegerOption()
    .setName("days")
    .setDescription("How much activity to analyze")
    .addChoices(
      { name: "7 days", value: 7 },
      { name: "14 days", value: 14 },
      { name: "30 days", value: 30 },
      { name: "All time", value: ALL_TIME_WINDOW },
    );
}

function resolveDays(raw: number | null): StatsWindow {
  if (raw !== null && isValidStatsWindow(raw)) return raw;
  return 14;
}

function initialState(
  sub: string,
  interaction: import("discord.js").ChatInputCommandInteraction,
  days: StatsWindow,
): StatsState | null {
  if (sub === "server") {
    return { scope: { type: "server" }, days, category: "home", chartPage: 0 };
  }
  if (sub === "user") {
    const user = interaction.options.getUser("user") ?? interaction.user;
    return { scope: { type: "user", userId: user.id }, days, category: "home", chartPage: 0 };
  }
  if (sub === "channel") {
    const channel =
      interaction.options.getChannel("channel") ??
      (interaction.channel?.isTextBased() ? interaction.channel : null);
    if (!channel || !("name" in channel)) return null;
    return { scope: { type: "channel", channelId: channel.id }, days, category: "home", chartPage: 0 };
  }
  return null;
}

export const statsCommands: SlashCommandDefinition[] = [
  {
    plugin: "stats",
    data: new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Browse activity statistics with interactive charts and analysis")
      .addSubcommand((sub) =>
        sub.setName("server").setDescription("Server activity dashboard").addIntegerOption(daysOption()),
      )
      .addSubcommand((sub) =>
        sub
          .setName("user")
          .setDescription("User activity dashboard")
          .addUserOption((o) => o.setName("user").setDescription("User to inspect"))
          .addIntegerOption(daysOption()),
      )
      .addSubcommand((sub) =>
        sub
          .setName("channel")
          .setDescription("Channel activity dashboard")
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
      const days = resolveDays(ctx.interaction.options.getInteger("days"));
      const permission = sub === "user" ? "can_user" : sub === "channel" ? "can_channel" : "can_server";
      const auth = await requirePluginPermission(ctx, "stats", permission);
      if (!auth) return;

      const state = initialState(sub, ctx.interaction, days);
      if (!state) {
        await ctx.interaction.reply(
          resultReply("Stats", "Could not resolve a text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      const message = await buildStatsMessage(state, ctx.interaction.guild!, ctx.client, ctx.guildConfig, ctx.ephemeral);
      await ctx.interaction.editReply({
        embeds: message.embeds,
        files: message.files,
        components: message.components,
      });
    },
  },
  {
    plugin: "stats",
    permission: "can_user",
    data: new SlashCommandBuilder()
      .setName("rank")
      .setDescription("Show a leaderboard-style rank card for a user")
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("Rank within this server or across every server")
          .setRequired(true)
          .addChoices({ name: "Server", value: "server" }, { name: "Global", value: "global" }),
      )
      .addUserOption((o) => o.setName("user").setDescription("User to look up")),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "stats", "can_user");
      if (!auth) return;

      const scope = ctx.interaction.options.getString("scope", true) as RankScope;
      const user = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
      const guild = ctx.interaction.guild!;

      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      const result = await renderUserRankCard(scope, guild, user);

      const leaderboardUrl =
        scope === "global"
          ? getGlobalLeaderboardUrl()
          : (publicLeaderboardUrl(guild.id) ?? getGuildStatsDashboardUrl(guild.id));
      const leaderboardLabel = scope === "global" ? "Global Leaderboard" : "Server Leaderboard";

      await ctx.interaction.editReply({
        content: `<:icons_trophy:1544418249721126922> <:dreamlinerlogo:1536010087468892161> This is your ${scope} rank. View [${leaderboardLabel}](<${leaderboardUrl}>)`,
        files: [new AttachmentBuilder(result.buffer, { name: "rank.png" })],
      });
    },
  },
];
