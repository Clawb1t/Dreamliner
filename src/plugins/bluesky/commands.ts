import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import { containerEdit, containerReply, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { parseComponentEmoji } from "../../core/emoji.js";
import { getGuildBlueskyDashboardUrl } from "../../core/docsUrl.js";
import { isDreamlinerOneActive } from "../../bridge/dreamlinerOne.js";
import { BLUESKY_BLUE } from "../../config/schemas/bluesky.js";
import { BLUESKY_COUNT_ID, BLUESKY_DISCONNECT_ID, BLUESKY_EMOJIS, blueskyFollowId } from "./constants.js";
import { BlueskyResolveError, resolveActor } from "./functions/api.js";
import { getAccount } from "./functions/accounts.js";
import { connectButtonRow, connectPrompt } from "./functions/messages.js";
import { isBlueskyOauthConfigured } from "./functions/oauth.js";
import { listFeeds, resolveMaxFeeds } from "./functions/store.js";

const PLUGIN = "bluesky";

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

async function runFeeds(ctx: SlashCommandContext): Promise<void> {
  const { t } = ctx;
  const guildId = ctx.interaction.guildId!;
  if (!(await requirePluginPermission(ctx, PLUGIN, "can_view"))) return;

  const [feeds, oneActive] = await Promise.all([listFeeds(guildId), isDreamlinerOneActive(guildId)]);
  const dashboardRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(BLUESKY_COUNT_ID)
      .setLabel(t("bluesky.feedCount", "{count}/{max} accounts", { count: feeds.length, max: resolveMaxFeeds(oneActive) }))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setLabel(t("bluesky.manageOnDashboard", "Manage on dashboard"))
      .setStyle(ButtonStyle.Link)
      .setURL(getGuildBlueskyDashboardUrl(guildId)),
  );

  if (!feeds.length) {
    await ctx.interaction.reply(
      resultReply(
        t("bluesky.feedsTitle", "Bluesky feeds"),
        t("bluesky.noFeeds", "This server doesn't post any Bluesky accounts yet. Add one on the dashboard."),
        ctx.ephemeral,
        slashResultOptions(ctx, { emoji: BLUESKY_EMOJIS.bluesky }),
        [dashboardRow],
      ),
    );
    return;
  }

  const lines = feeds.map((feed) =>
    t("bluesky.feedLine", "**{name}** ([@{handle}](https://bsky.app/profile/{handle})) · <#{channelId}> · {status}", {
      name: feed.displayName || feed.handle,
      handle: feed.handle,
      channelId: feed.discordChannelId,
      status: feed.enabled ? t("bluesky.statusLive", "live") : t("bluesky.statusPaused", "paused"),
    }),
  );
  const container = setEmbedAuthor(
    baseEmbed(),
    t("bluesky.feedsTitle", "Bluesky feeds"),
    ctx.client,
    commandHeader(ctx.guildConfig, { emoji: BLUESKY_EMOJIS.bluesky }),
  ).setDescription(trimLines(lines.join("\n")));
  await ctx.interaction.reply(containerReply(container, ctx.ephemeral, [dashboardRow]));
}

async function runProfile(ctx: SlashCommandContext): Promise<void> {
  const { t } = ctx;
  if (!(await requirePluginPermission(ctx, PLUGIN, "can_use"))) return;
  const input = ctx.interaction.options.getString("handle", true);
  await ctx.interaction.deferReply(ctx.ephemeral ? { flags: MessageFlags.Ephemeral } : {});

  let profile;
  try {
    profile = await resolveActor(input);
  } catch (error) {
    const message =
      error instanceof BlueskyResolveError ? error.message : t("bluesky.lookupFailed", "Couldn't reach Bluesky. Try again shortly.");
    await ctx.interaction.editReply(resultEdit(t("bluesky.notFoundTitle", "Not found"), message, slashResultOptions(ctx, { tone: "error" })));
    return;
  }

  const stats = t("bluesky.profileStats", "**{followers}** followers · **{following}** following · **{posts}** posts", {
    followers: formatCount(profile.followersCount),
    following: formatCount(profile.followsCount),
    posts: formatCount(profile.postsCount),
  });
  const description = [`**${profile.displayName}** · [@${profile.handle}](${profile.url})`, profile.description.trim(), stats]
    .filter(Boolean)
    .join("\n\n");
  const container = baseEmbed()
    .setColor(BLUESKY_BLUE)
    .setThumbnail(profile.avatarUrl)
    .setDescription(description)
    .setFooter({ text: `${BLUESKY_EMOJIS.bluesky} Bluesky` });
  if (profile.bannerUrl) container.setImage(profile.bannerUrl);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(blueskyFollowId(profile.did))
      .setLabel(t("bluesky.followButton", "Follow"))
      .setEmoji(parseComponentEmoji(BLUESKY_EMOJIS.people) ?? "➕")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel(t("bluesky.openButton", "Open on Bluesky")).setStyle(ButtonStyle.Link).setURL(profile.url),
  );
  await ctx.interaction.editReply(containerEdit(container, [row]));
}

async function runAccount(ctx: SlashCommandContext): Promise<void> {
  const { t } = ctx;
  if (!(await requirePluginPermission(ctx, PLUGIN, "can_use"))) return;

  if (!isBlueskyOauthConfigured()) {
    await ctx.interaction.reply(
      resultReply(
        t("bluesky.accountTitle", "Bluesky account"),
        t("bluesky.notConfigured", "Bluesky accounts aren't set up on this bot yet."),
        true,
        slashResultOptions(ctx, { tone: "warning" }),
      ),
    );
    return;
  }

  const account = await getAccount(ctx.interaction.user.id);
  if (!account) {
    const { container, rows } = connectPrompt(ctx.client, t);
    await ctx.interaction.reply(containerReply(container, true, rows));
    return;
  }

  const container = setEmbedAuthor(baseEmbed(), t("bluesky.accountTitle", "Bluesky account"), ctx.client, {
    emoji: BLUESKY_EMOJIS.bluesky,
    thumbnailURL: account.avatarUrl,
    emojis: ctx.guildConfig.emojis,
  }).setDescription(
    [
      t("bluesky.connectedAs", "Connected as **{name}** ([@{handle}](https://bsky.app/profile/{handle})).", {
        name: account.displayName || account.handle,
        handle: account.handle,
      }),
      t(
        "bluesky.connectedHelp",
        "React 💙 to a Bluesky post, or press Like, Repost or Follow on a Dreamliner card, and it happens on your account.",
      ),
    ].join("\n\n"),
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(BLUESKY_DISCONNECT_ID)
      .setLabel(t("bluesky.disconnectButton", "Disconnect"))
      .setEmoji(parseComponentEmoji(BLUESKY_EMOJIS.disconnect) ?? "✖️")
      .setStyle(ButtonStyle.Danger),
    ...connectButtonRow(t).components.map((button) => button.setLabel(t("bluesky.manageButton", "Manage connection"))),
  );
  await ctx.interaction.reply(containerReply(container, true, [row]));
}

export const blueskyCommands: SlashCommandDefinition[] = [
  {
    plugin: PLUGIN,
    data: new SlashCommandBuilder()
      .setName("bluesky")
      .setDescription("Bluesky feeds, profiles and your connected account")
      .addSubcommand((sub) => sub.setName("feeds").setDescription("List the Bluesky accounts this server posts"))
      .addSubcommand((sub) =>
        sub
          .setName("profile")
          .setDescription("Show a Bluesky profile")
          .addStringOption((option) =>
            option.setName("handle").setDescription("Handle, profile link or DID, e.g. alice.bsky.social").setRequired(true).setMaxLength(256),
          ),
      )
      .addSubcommand((sub) => sub.setName("account").setDescription("Connect or disconnect your Bluesky account")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      if (sub === "feeds") await runFeeds(ctx);
      else if (sub === "profile") await runProfile(ctx);
      else await runAccount(ctx);
    },
  },
];
