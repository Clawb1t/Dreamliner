import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { listWatchers, resolveMaxWatchers } from "./functions/store.js";
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

      const rows = await listWatchers(guildId);
      if (!rows.length) {
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

      const lines = rows.map((row) => {
        const status = row.enabled ? ctx.t("social.statusLive", "live") : ctx.t("social.statusDisabled", "disabled");
        return ctx.t("social.watcherLine", "**{name}** (YouTube) · <#{channelId}> · {status}", {
          name: row.sourceChannelName,
          channelId: row.discordChannelId,
          status,
        });
      });

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
              .setLabel(ctx.t("social.watcherCountLabel", "{count}/{max} notifications", { count: rows.length, max: maxWatchers }))
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
          ),
        ]),
      );
    },
  },
];
