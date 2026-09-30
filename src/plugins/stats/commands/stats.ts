import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandIntegerOption,
} from "discord.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../../core/types.js";
import { deferReplyOptions, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { getGlobalLeaderboardUrl, getGuildStatsDashboardUrl, getPublicProfileUrl } from "../../../core/docsUrl.js";
import { publicLeaderboardUrl } from "../../../core/publicLeaderboard.js";
import { ALL_TIME_WINDOW, isValidStatsWindow, type StatsWindow } from "../functions/daily.js";
import { buildStatsMessage, type StatsState } from "../functions/ui/index.js";
import { renderUserRankCard, type RankScope } from "../functions/rank.js";
import { renderUserProfileCard, type ProfileStatsSummary } from "../functions/profileCard.js";
import { getUserProfile } from "../../../bridge/userProfiles.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("stats");

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
          resultReply(
            ctx.t("stats.title", "Stats"),
            ctx.t("stats.couldNotResolveChannel", "Could not resolve a text channel."),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      const message = await buildStatsMessage(state, ctx.interaction.guild!, ctx.client, ctx.guildConfig, ctx.ephemeral, ctx.t);
      await ctx.interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        files: message.files,
        components: message.components,
        allowedMentions: message.allowedMentions,
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

      const started = Date.now();
      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral)).catch((error: unknown) => {
        log.error(`[rank] defer failed after ${Date.now() - started}ms (Discord never got the "thinking..." reply)`);
        throw error;
      });
      const deferredMs = Date.now() - started;
      const result = await renderUserRankCard(scope, guild, user, ctx.t);
      const renderedMs = Date.now() - started;

      const leaderboardUrl =
        scope === "global"
          ? getGlobalLeaderboardUrl()
          : (publicLeaderboardUrl(guild.id) ?? getGuildStatsDashboardUrl(guild.id));
      // Just the card: the rank and the leaderboard link live in the buttons underneath.
      const components = [rankButtonsRow(scope, result.rank, leaderboardUrl, ctx.t)];

      try {
        await ctx.interaction.editReply({
          content: "",
          files: [new AttachmentBuilder(result.buffer, { name: "rank.png" })],
          components,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        // Never leave the member staring at "thinking...": if the card upload fails, still answer
        // with the numbers, and log where the time went so a slow step is easy to spot.
        log.error(
          `[rank] card upload failed (defer ${deferredMs}ms, render ${renderedMs - deferredMs}ms, upload ${Date.now() - started - renderedMs}ms, ${result.buffer.length} bytes):`,
          error,
        );
        await ctx.interaction.editReply({
          content: `**#${result.rank.toLocaleString()}** of ${result.totalRanked.toLocaleString()} · ${result.count.toLocaleString()} msgs`,
          files: [],
          components,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (Date.now() - started > 5_000) {
        log.warn(`[rank] slow reply: defer ${deferredMs}ms, render ${renderedMs - deferredMs}ms, upload ${Date.now() - started - renderedMs}ms`);
      }
    },
  },
  {
    plugin: "stats",
    permission: "can_user",
    data: new SlashCommandBuilder()
      .setName("profile")
      .setDescription("Show a user's Dreamliner profile card")
      .addUserOption((o) => o.setName("user").setDescription("User to show (defaults to you)")),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "stats", "can_user");
      if (!auth) return;

      const user = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
      const isSelf = user.id === ctx.interaction.user.id;
      // Same rule as the website: a private profile is only visible to its owner.
      if (!isSelf && !(await getUserProfile(user.id)).profileVisible) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("stats.profileTitle", "Profile"),
            ctx.t("stats.profilePrivate", "<@{user}>'s profile is private.", { user: user.id }),
            true,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      const started = Date.now();
      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      const result = await renderUserProfileCard(ctx.client, user, ctx.interaction.user.id);
      if (!result.ok) {
        await ctx.interaction.editReply({
          content: ctx.t("stats.profilePrivate", "<@{user}>'s profile is private.", { user: user.id }),
          allowedMentions: { parse: [] },
        });
        return;
      }

      // Just the card: its stats and the full-profile link live in the buttons underneath.
      await ctx.interaction.editReply({
        content: "",
        files: [new AttachmentBuilder(result.buffer, { name: "profile.png" })],
        components: [profileButtonsRow(result.stats, getPublicProfileUrl(user.id), ctx.t)],
        allowedMentions: { parse: [] },
      });
      if (Date.now() - started > 5_000) log.warn(`[profile] slow reply: ${Date.now() - started}ms`);
    },
  },
];

const PROFILE_BUTTON_EMOJIS = {
  messages: "<:icons_message:1544417564447350804>",
  servers: "<:icons_serverinsight:1544417809109352489>",
  rank: "<:icons_trophy:1544418249721126922>",
  profile: "<:icons_user_profile:1544418271355469885>",
};

/** The row under the /profile card: disabled buttons used as stat labels (messages, servers,
 *  global rank), then a link to the full profile on the site. */
function profileButtonsRow(stats: ProfileStatsSummary, profileUrl: string, t: SlashCommandContext["t"]): ActionRowBuilder<ButtonBuilder> {
  const count = (value: number) => value.toLocaleString("en-US");
  const label = (id: keyof typeof PROFILE_BUTTON_EMOJIS, style: ButtonStyle, text: string) =>
    new ButtonBuilder()
      .setCustomId(`dl:profile:stat:${id}`)
      .setStyle(style)
      .setEmoji(PROFILE_BUTTON_EMOJIS[id])
      .setLabel(text)
      .setDisabled(true);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    label(
      "messages",
      ButtonStyle.Primary,
      stats.totalMessages === 1
        ? t("stats.profileMessagesOne", "1 Message")
        : t("stats.profileMessages", "{count} Messages", { count: count(stats.totalMessages) }),
    ),
    label(
      "servers",
      ButtonStyle.Success,
      stats.serverCount === 1
        ? t("stats.profileServersOne", "1 Server")
        : t("stats.profileServers", "{count} Servers", { count: count(stats.serverCount) }),
    ),
    label(
      "rank",
      ButtonStyle.Secondary,
      stats.globalRank
        ? t("stats.profileGlobalRank", "Global Rank #{rank}", { rank: count(stats.globalRank) })
        : t("stats.profileGlobalRankNone", "Global Rank: unranked"),
    ),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(profileUrl)
      .setEmoji(PROFILE_BUTTON_EMOJIS.profile)
      .setLabel(t("stats.profileViewFull", "View Full Profile")),
  );
}

const RANK_BUTTON_EMOJIS = {
  rank: "<:icons_trophy:1544418249721126922>",
  leaderboard: "<:icons_growth:1544417796631302164>",
};

/** The row under the /rank card: the rank as a disabled blurple label, then a link to the matching
 *  leaderboard on the site. */
function rankButtonsRow(
  scope: RankScope,
  rank: number,
  leaderboardUrl: string,
  t: SlashCommandContext["t"],
): ActionRowBuilder<ButtonBuilder> {
  const rankText = rank.toLocaleString("en-US");
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dl:rank:stat:${scope}`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji(RANK_BUTTON_EMOJIS.rank)
      .setLabel(
        scope === "global"
          ? t("stats.rankGlobalLabel", "Global Rank #{rank}", { rank: rankText })
          : t("stats.rankServerLabel", "Server Rank #{rank}", { rank: rankText }),
      )
      .setDisabled(true),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(leaderboardUrl)
      .setEmoji(RANK_BUTTON_EMOJIS.leaderboard)
      .setLabel(
        scope === "global"
          ? t("stats.viewGlobalLeaderboard", "View Global Leaderboard")
          : t("stats.viewServerLeaderboard", "View Server Leaderboard"),
      ),
  );
}
