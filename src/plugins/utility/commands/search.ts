import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { contentEdit, resultEdit, slashResultOptions, deferReplyOptions } from "../../../core/responses.js";
import { requireUtilityPermission, BanMembers, requireDiscordPerm } from "../functions/commandHelpers.js";
import { searchMembers, searchBans, formatSearchPage, formatBanSearchPage } from "../functions/search.js";
import { buildUserInfoEmbed } from "../functions/info.js";

export const searchCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_search",
    data: new SlashCommandBuilder()
      .setName("search")
      .setDescription("Search members in this server")
      .addStringOption((o) => o.setName("query").setDescription("Search query").setRequired(false))
      .addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1))
      .addBooleanOption((o) => o.setName("in_voice").setDescription("Only members in voice"))
      .addBooleanOption((o) => o.setName("bots_only").setDescription("Only bots"))
      .addBooleanOption((o) => o.setName("case_sensitive").setDescription("Case-sensitive search"))
      .addBooleanOption((o) => o.setName("regex").setDescription("Treat query as regex"))
      .addBooleanOption((o) => o.setName("ids_only").setDescription("Output IDs only"))
      .addStringOption((o) =>
        o
          .setName("sort")
          .setDescription("Sort order")
          .addChoices(
            { name: "Name", value: "name" },
            { name: "Joined", value: "joined" },
            { name: "Created", value: "created" },
            { name: "Level", value: "level" },
          ),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_search");
      if (!auth) return;
      const { interaction, guildConfig } = ctx;
      await interaction.deferReply(deferReplyOptions(ctx.ephemeral));

      const result = await searchMembers(interaction.guild!, guildConfig, {
        query: interaction.options.getString("query") ?? "",
        page: interaction.options.getInteger("page") ?? 1,
        inVoice: interaction.options.getBoolean("in_voice") ?? false,
        botsOnly: interaction.options.getBoolean("bots_only") ?? false,
        caseSensitive: interaction.options.getBoolean("case_sensitive") ?? false,
        regex: interaction.options.getBoolean("regex") ?? false,
        idsOnly: interaction.options.getBoolean("ids_only") ?? false,
        sort: (interaction.options.getString("sort") as "name" | "joined" | "created" | "level") ?? "name",
      });

      if (result.total === 0) {
        await interaction.editReply(resultEdit("Search", "No results found.", slashResultOptions(ctx)));
        return;
      }

      const infoOnSingle = auth.pluginConfig.info_on_single_result !== false;
      if (infoOnSingle && result.total === 1 && result.members[0]) {
        const m = result.members[0];
        await interaction.editReply({
          content: "Only one result:",
          embeds: [await buildUserInfoEmbed(m.user, m, guildConfig, interaction.guildId!, ctx.client)],
        });
        return;
      }

      await interaction.editReply(
        contentEdit(formatSearchPage(result, interaction.options.getBoolean("ids_only") ?? false)),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_search",
    data: new SlashCommandBuilder()
      .setName("bansearch")
      .setDescription("Search banned users")
      .addStringOption((o) => o.setName("query").setDescription("Search query").setRequired(true))
      .addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1))
      .addBooleanOption((o) => o.setName("case_sensitive").setDescription("Case-sensitive search"))
      .addBooleanOption((o) => o.setName("regex").setDescription("Treat query as regex")),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_search");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, BanMembers, "Ban Members", ctx.ephemeral, ctx.guildConfig))) return;

      await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
      const result = await searchBans(ctx.interaction.guild!, {
        query: ctx.interaction.options.getString("query", true),
        page: ctx.interaction.options.getInteger("page") ?? 1,
        caseSensitive: ctx.interaction.options.getBoolean("case_sensitive") ?? false,
        regex: ctx.interaction.options.getBoolean("regex") ?? false,
      });

      if (result.total === 0) {
        await ctx.interaction.editReply(resultEdit("Ban search", "No results found.", slashResultOptions(ctx)));
        return;
      }

      await ctx.interaction.editReply(
        contentEdit(
          formatBanSearchPage(result.bans, result.page, result.totalPages, result.total, result.from, result.to),
        ),
      );
    },
  },
];
