import { MessageFlags, SlashCommandBuilder, type AutocompleteInteraction } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { getGuildSocialDashboardUrl, siteLinkRow } from "../../core/docsUrl.js";
import { isDreamlinerOneActive } from "../../bridge/dreamlinerOne.js";
import { getSourcesByIds, getSubscription, listSubscriptions, resolveMaxWatchers, type FeedSourceRow } from "./feeds/store.js";
import { setFeedEnabled, testSendFeed } from "./feeds/service.js";
import { FEED_EMOJIS } from "./feeds/catalog.js";
import { emojiFor } from "./feeds/render.js";

const TITLE_EMOJI = FEED_EMOJIS.notify;

const TYPE_LABELS: Record<string, string> = {
  youtube: "YouTube",
  twitch: "Twitch",
  rss: "RSS",
  steam: "Steam",
  github: "GitHub",
  statuspage: "Status",
  newswire: "Newswire",
};

function feedName(source: FeedSourceRow | undefined): string {
  return (source?.title || "Unknown feed").replace(/[*_`~|]/g, "");
}

/** Feed choices for the `feed` option: this server's feeds only. */
export async function handleNotificationsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.respond([]);
    return;
  }
  const query = String(interaction.options.getFocused()).toLowerCase();
  const sub = interaction.options.getSubcommand(false);
  const subscriptions = await listSubscriptions(guildId);
  const sources = await getSourcesByIds(subscriptions.map((s) => s.sourceId));
  const choices = subscriptions
    .filter((s) => (sub === "pause" ? s.enabled : sub === "resume" ? !s.enabled : true))
    .map((s) => {
      const source = sources.get(s.sourceId);
      return { name: `${feedName(source)} (${TYPE_LABELS[source?.type ?? ""] ?? "Feed"})`.slice(0, 100), value: String(s.id) };
    })
    .filter((c) => !query || c.name.toLowerCase().includes(query))
    .slice(0, 25);
  await interaction.respond(choices);
}

export const socialCommands: SlashCommandDefinition[] = [
  {
    plugin: "social",
    subcommandPermissions: { list: "can_view", test: "can_manage", pause: "can_manage", resume: "can_manage" },
    data: new SlashCommandBuilder()
      .setName("notifications")
      .setDescription("This server's notification feeds (YouTube, Twitch, RSS, newswires and more)")
      .addSubcommand((s) => s.setName("list").setDescription("List this server's notification feeds"))
      .addSubcommand((s) =>
        s
          .setName("test")
          .setDescription("Post a test of a feed's message, using its newest item")
          .addStringOption((o) => o.setName("feed").setDescription("The feed to test").setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("pause")
          .setDescription("Pause a feed")
          .addStringOption((o) => o.setName("feed").setDescription("The feed to pause").setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("resume")
          .setDescription("Resume a paused feed (nothing posted while it was paused is sent late)")
          .addStringOption((o) => o.setName("feed").setDescription("The feed to resume").setRequired(true).setAutocomplete(true)),
      ),
    execute: async (ctx) => {
      const guildId = ctx.interaction.guildId!;
      const sub = ctx.interaction.options.getSubcommand();
      const title = ctx.t("social.title", "Notifications");
      const dashboardRow = () =>
        siteLinkRow({ label: ctx.t("social.openDashboard", "Manage on the dashboard"), url: getGuildSocialDashboardUrl(guildId) });

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "social", "can_view");
        if (!auth) return;
        const [subscriptions, oneActive] = await Promise.all([listSubscriptions(guildId), isDreamlinerOneActive(guildId)]);
        const max = resolveMaxWatchers(oneActive);
        if (!subscriptions.length) {
          await ctx.interaction.reply(
            resultReply(
              title,
              ctx.t("social.noneConfigured", "No notification feeds yet. Add creators, RSS feeds and newswires on the dashboard."),
              ctx.ephemeral,
              slashResultOptions(ctx, { emoji: TITLE_EMOJI }),
              [dashboardRow()],
            ),
          );
          return;
        }
        const sources = await getSourcesByIds(subscriptions.map((s) => s.sourceId));
        const lines = subscriptions.map((s) => {
          const source = sources.get(s.sourceId);
          const status = !s.enabled
            ? ctx.t("social.statusPaused", "paused")
            : source?.disabledReason
              ? ctx.t("social.statusFailing", "failing")
              : ctx.t("social.statusLive", "live");
          return ctx.t("social.feedLine", "{emoji} **{name}** ({type}) · <#{channelId}> · {status}", {
            emoji: source ? emojiFor(source) : FEED_EMOJIS.rss,
            name: feedName(source),
            type: TYPE_LABELS[source?.type ?? ""] ?? "Feed",
            channelId: s.channelId,
            status,
          });
        });
        const embed = setEmbedAuthor(baseEmbed(), title, ctx.client, commandHeader(ctx.guildConfig, { emoji: TITLE_EMOJI }))
          .setDescription(trimLines(lines.join("\n")))
          .setFooter({ text: ctx.t("social.feedCount", "{count} of {max} feeds", { count: subscriptions.length, max }) });
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral, [dashboardRow()]));
        return;
      }

      const auth = await requirePluginPermission(ctx, "social", "can_manage");
      if (!auth) return;
      const id = Number(ctx.interaction.options.getString("feed", true));
      const subscription = Number.isInteger(id) ? await getSubscription(guildId, id) : null;
      if (!subscription) {
        await ctx.interaction.reply(
          resultReply(title, ctx.t("social.feedNotFound", "That feed doesn't exist in this server."), true, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }
      const source = (await getSourcesByIds([subscription.sourceId])).get(subscription.sourceId);
      const name = feedName(source);

      if (sub === "test") {
        await ctx.interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await testSendFeed(ctx.client, guildId, id);
        await ctx.interaction.editReply(
          resultEdit(
            title,
            result.ok
              ? ctx.t("social.testSent", "Posted a test of **{name}** in <#{channelId}>.", { name, channelId: result.channelId })
              : result.error,
            slashResultOptions(ctx, result.ok ? { emoji: TITLE_EMOJI } : { tone: "error" }),
          ),
        );
        return;
      }

      const enable = sub === "resume";
      if (subscription.enabled === enable) {
        await ctx.interaction.reply(
          resultReply(
            title,
            enable
              ? ctx.t("social.alreadyLive", "**{name}** isn't paused.", { name })
              : ctx.t("social.alreadyPaused", "**{name}** is already paused.", { name }),
            true,
            slashResultOptions(ctx, { emoji: TITLE_EMOJI }),
          ),
        );
        return;
      }
      await ctx.interaction.deferReply(ctx.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      await setFeedEnabled(guildId, id, enable);
      await ctx.interaction.editReply(
        resultEdit(
          title,
          enable
            ? ctx.t("social.resumed", "{emoji} Resumed **{name}**. New posts go to <#{channelId}> again.", { emoji: FEED_EMOJIS.play, name, channelId: subscription.channelId })
            : ctx.t("social.paused", "{emoji} Paused **{name}**. Nothing posts until it's resumed.", { emoji: FEED_EMOJIS.pause, name }),
          slashResultOptions(ctx, { emoji: TITLE_EMOJI }),
        ),
      );
    },
  },
];
