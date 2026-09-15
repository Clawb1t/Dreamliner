import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { discordTimestamp } from "../../../core/datetime.js";
import { getUserNameHistory, searchNameHistory } from "../functions/store.js";
import type { Translator } from "../../../i18n/index.js";

function changeTypeLabel(changeType: string, t: Translator): string {
  if (changeType === "nickname") return t("name_history.changeTypeNickname", "nickname");
  if (changeType === "username") return t("name_history.changeTypeUsername", "username");
  return changeType;
}

function formatEntry(
  entry: { oldName: string; newName: string; changeType: string; changedAt: Date; userId: string },
  t: Translator,
): string {
  return `\`${entry.oldName}\` → \`${entry.newName}\` (${changeTypeLabel(entry.changeType, t)}) · <@${entry.userId}> · ${discordTimestamp(entry.changedAt, "R")}`;
}

export const namesCommands: SlashCommandDefinition[] = [
  {
    plugin: "name_history",
    data: new SlashCommandBuilder()
      .setName("names")
      .setDescription("View nickname and username history")
      .addSubcommand((sub) =>
        sub
          .setName("user")
          .setDescription("Show name history for a user")
          .addUserOption((o) => o.setName("user").setDescription("User to look up").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("search")
          .setDescription("Search name history")
          .addStringOption((o) => o.setName("query").setDescription("User ID or name fragment")),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "user") {
        const auth = await requirePluginPermission(ctx, "name_history", "can_view");
        if (!auth) return;
        const user = ctx.interaction.options.getUser("user", true);
        const entries = await getUserNameHistory(guildId, user.id);
        if (!entries.length) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("name_history.nameHistoryTitle", "Name history"),
              ctx.t("name_history.noRecordedNameChanges", "No recorded name changes for **{user}**.", { user: user.tag }),
              ctx.ephemeral,
              slashResultOptions(ctx, { emoji: "<:icons_aka:1544417681799913482>" }),
            ),
          );
          return;
        }
        const lines = entries.map((e) => formatEntry(e, ctx.t));
        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(
              baseEmbed(),
              ctx.t("name_history.nameHistoryUserTitle", "Name history · {user}", { user: user.tag }),
              ctx.client,
              commandHeader(ctx.guildConfig, { emoji: "<:icons_aka:1544417681799913482>" }),
            ).addFields(embedField(ctx.t("name_history.fieldChanges", "Changes"), trimLines(lines.join("\n")))),
            ctx.ephemeral,
          ),
        );
        return;
      }

      if (sub === "search") {
        const auth = await requirePluginPermission(ctx, "name_history", "can_search");
        if (!auth) return;
        const query = ctx.interaction.options.getString("query") ?? "";
        const entries = await searchNameHistory(guildId, query);
        if (!entries.length) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("name_history.nameHistoryTitle", "Name history"),
              ctx.t("name_history.noMatchingNameChanges", "No matching name changes found."),
              ctx.ephemeral,
              slashResultOptions(ctx, { emoji: "<:icons_text_search:1544418237675077702>" }),
            ),
          );
          return;
        }
        const lines = entries.map((e) => formatEntry(e, ctx.t));
        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(
              baseEmbed(),
              query
                ? ctx.t("name_history.nameSearchQueryTitle", "Name search: {query}", { query })
                : ctx.t("name_history.nameSearchTitle", "Name search"),
              ctx.client,
              commandHeader(ctx.guildConfig, { emoji: "<:icons_text_search:1544418237675077702>" }),
            ).addFields(embedField(ctx.t("name_history.fieldResults", "Results"), trimLines(lines.join("\n")))),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
