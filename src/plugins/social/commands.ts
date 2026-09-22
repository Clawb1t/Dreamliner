import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { listWatchers, resolveMaxWatchers } from "./functions/store.js";
import { listTwitchWatchers } from "./functions/storeTwitch.js";
import { isDreamlinerOneActive } from "../../bridge/dreamlinerOne.js";

export const socialCommands: SlashCommandDefinition[] = [
  {
    plugin: "social",
    data: new SlashCommandBuilder()
      .setName("social")
      .setDescription("List this server's configured social notifications"),
    execute: async (ctx) => {
      const guildId = ctx.interaction.guildId!;
      const auth = await requirePluginPermission(ctx, "social", "can_view");
      if (!auth) return;

      const [youtubeRows, twitchRows] = await Promise.all([listWatchers(guildId), listTwitchWatchers(guildId)]);
      const total = youtubeRows.length + twitchRows.length;

      if (!total) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("social.title", "Social notifications"),
            ctx.t("social.noneConfigured", "No social notifications configured yet."),
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_youtube:1544417751022567455>" }),
          ),
        );
        return;
      }

      const watcherLine = (name: string, platform: string, channelId: string, enabled: boolean) => {
        const status = enabled ? ctx.t("social.statusLive", "live") : ctx.t("social.statusDisabled", "disabled");
        return ctx.t("social.watcherLine", "**{name}** ({platform}) · <#{channelId}> · {status}", {
          name,
          platform,
          channelId,
          status,
        });
      };

      const lines = [
        ...youtubeRows.map((row) => watcherLine(row.sourceChannelName, "YouTube", row.discordChannelId, row.enabled)),
        ...twitchRows.map((row) => watcherLine(row.sourceUserDisplayName, "Twitch", row.discordChannelId, row.enabled)),
      ];

      const embed = setEmbedAuthor(
        baseEmbed(),
        ctx.t("social.title", "Social notifications"),
        ctx.client,
        commandHeader(ctx.guildConfig, { emoji: "<:icons_youtube:1544417751022567455>" }),
      ).setDescription(trimLines(lines.join("\n")));

      const maxWatchers = resolveMaxWatchers(await isDreamlinerOneActive(guildId));

      await ctx.interaction.reply(
        embedReply(embed, ctx.ephemeral, [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("dl:social:stat:total")
              .setLabel(ctx.t("social.watcherCountLabel", "{count}/{max} notifications", { count: total, max: maxWatchers }))
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
          ),
        ]),
      );
    },
  },
];
