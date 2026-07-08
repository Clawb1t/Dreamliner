import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { discordTimestamp } from "../../../core/datetime.js";
import { getUserNameHistory, searchNameHistory } from "../functions/store.js";

function formatEntry(entry: { oldName: string; newName: string; changeType: string; changedAt: Date; userId: string }): string {
  return `\`${entry.oldName}\` → \`${entry.newName}\` (${entry.changeType}) · <@${entry.userId}> · ${discordTimestamp(entry.changedAt, "R")}`;
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
            resultReply("Name history", `No recorded name changes for **${user.tag}**.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        const lines = entries.map(formatEntry);
        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), `Name history · ${user.tag}`, ctx.client, commandHeader(ctx.guildConfig))
              .addFields(embedField("Changes", trimLines(lines.join("\n")))),
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
            resultReply("Name history", "No matching name changes found.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        const lines = entries.map(formatEntry);
        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), `Name search${query ? `: ${query}` : ""}`, ctx.client, commandHeader(ctx.guildConfig))
              .addFields(embedField("Results", trimLines(lines.join("\n")))),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
