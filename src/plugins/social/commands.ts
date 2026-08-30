import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { getGuildSocialDashboardUrl, linkButton } from "../../core/docsUrl.js";
import { listWatchers, resolveMaxWatchers } from "./functions/store.js";
import { isDreamlinerOneActive } from "../../bridge/dreamlinerOne.js";

export const socialCommands: SlashCommandDefinition[] = [
  {
    plugin: "social",
    data: new SlashCommandBuilder()
      .setName("social")
      .setDescription("Social notifications for this server")
      .addSubcommand((sub) => sub.setName("list").setDescription("List configured social notifications"))
      .addSubcommand((sub) => sub.setName("info").setDescription("Where to set up social notifications")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "info") {
        const url = getGuildSocialDashboardUrl(guildId);
        await ctx.interaction.reply({
          ...resultReply(
            "Set up social notifications",
            "Social notifications are built on the dashboard: pick a creator (YouTube for now), the channel to post in, and customize the embed with a live preview. Open the dashboard's Social section for this server to get started.",
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton("Open social dashboard", url))],
        });
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "social", "can_view");
        if (!auth) return;

        const rows = await listWatchers(guildId);
        if (!rows.length) {
          await ctx.interaction.reply(
            resultReply("Social notifications", "No social notifications configured yet.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const lines = rows.map((row) => {
          const status = row.enabled ? "live" : "disabled";
          return `**${row.sourceChannelName}** (YouTube) · <#${row.discordChannelId}> · ${status}`;
        });

        const embed = setEmbedAuthor(
          baseEmbed(),
          "Social notifications",
          ctx.client,
          commandHeader(ctx.guildConfig),
        ).setDescription(trimLines(lines.join("\n")));

        const maxWatchers = resolveMaxWatchers(await isDreamlinerOneActive(guildId));

        await ctx.interaction.reply({
          ...embedReply(embed, ctx.ephemeral),
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("dl:social:stat:total")
                .setLabel(`${rows.length}/${maxWatchers} notifications`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            ),
          ],
        });
      }
    },
  },
];
