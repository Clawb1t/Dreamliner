import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { containerEdit, contentEdit, embedEdit, resultEdit, slashResultOptions, deferReplyOptions } from "../../../core/responses.js";
import { requireUtilityPermission, BanMembers, requireDiscordPerm } from "../functions/commandHelpers.js";
import { searchMembers, searchBans, formatSearchIds, SEARCH_EMOJI, type SearchSort } from "../functions/search.js";
import { memberSearchPayload, banSearchPayload } from "../functions/searchUi.js";
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
            { name: "Role", value: "role" },
          ),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_search");
      if (!auth) return;
      const { interaction, guildConfig } = ctx;
      await interaction.deferReply(deferReplyOptions(ctx.ephemeral));

      const idsOnly = interaction.options.getBoolean("ids_only") ?? false;
      const state = {
        kind: "m" as const,
        page: interaction.options.getInteger("page") ?? 1,
        inVoice: interaction.options.getBoolean("in_voice") ?? false,
        botsOnly: interaction.options.getBoolean("bots_only") ?? false,
        caseSensitive: interaction.options.getBoolean("case_sensitive") ?? false,
        regex: interaction.options.getBoolean("regex") ?? false,
        sort: (interaction.options.getString("sort") as SearchSort) ?? "name",
        query: interaction.options.getString("query") ?? "",
      };

      const result = await searchMembers(interaction.guild!, { ...state, idsOnly });

      if (result.total === 0) {
        await interaction.editReply(
          resultEdit(ctx.t("utility.search.searchTitle", "Search"), ctx.t("utility.search.noResultsFound", "No results found."), slashResultOptions(ctx, { emoji: SEARCH_EMOJI })),
        );
        return;
      }

      const infoOnSingle = auth.pluginConfig.info_on_single_result !== false;
      if (infoOnSingle && result.total === 1 && result.members[0]) {
        const m = result.members[0];
        await interaction.editReply(
          embedEdit(await buildUserInfoEmbed(m.user, m, guildConfig, interaction.guildId!, ctx.client, false, ctx.t)),
        );
        return;
      }

      if (idsOnly) {
        await interaction.editReply(contentEdit(formatSearchIds(result, ctx.t)));
        return;
      }

      const { container, rows } = memberSearchPayload(state, result, ctx.client, guildConfig, ctx.t);
      await interaction.editReply(containerEdit(container, rows));
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
      if (!(await requireDiscordPerm(ctx.interaction, BanMembers, "Ban Members", ctx.ephemeral, ctx.guildConfig, ctx.t))) return;

      await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });
      const state = {
        kind: "b" as const,
        page: ctx.interaction.options.getInteger("page") ?? 1,
        caseSensitive: ctx.interaction.options.getBoolean("case_sensitive") ?? false,
        regex: ctx.interaction.options.getBoolean("regex") ?? false,
        query: ctx.interaction.options.getString("query", true),
      };
      const result = await searchBans(ctx.interaction.guild!, state);

      if (result.total === 0) {
        await ctx.interaction.editReply(
          resultEdit(ctx.t("utility.search.banSearchTitle", "Ban search"), ctx.t("utility.search.noResultsFound", "No results found."), slashResultOptions(ctx, { emoji: SEARCH_EMOJI })),
        );
        return;
      }

      const { container, rows } = banSearchPayload(state, result, ctx.client, ctx.guildConfig, ctx.t);
      await ctx.interaction.editReply(containerEdit(container, rows));
    },
  },
];
