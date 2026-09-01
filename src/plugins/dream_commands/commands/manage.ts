import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { getGuildCommandsDashboardUrl, linkButton } from "../../../core/docsUrl.js";
import {
  deleteDreamCommand,
  getDreamCommand,
  listDreamCommands,
  MAX_DREAM_COMMANDS,
  updateDreamCommand,
} from "../functions/store.js";
import { syncGuildDreamSlashCommands } from "../functions/guildSlash.js";
import { formatTriggerLabel } from "../functions/run.js";

function listStatRow(total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("dl:dreamcmd:stat:total")
      .setLabel(`${total}/${MAX_DREAM_COMMANDS} commands`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

export const dreamCommandManageCommands: SlashCommandDefinition[] = [
  {
    plugin: "dream_commands",
    data: new SlashCommandBuilder()
      .setName("command")
      .setDescription("Manage custom slash commands")
      .addSubcommand((sub) => sub.setName("list").setDescription("List this server's custom commands"))
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a custom command")
          .addStringOption((o) => o.setName("name").setDescription("Command name").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("toggle")
          .setDescription("Enable or disable a custom command")
          .addStringOption((o) => o.setName("name").setDescription("Command name").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("info").setDescription("Where to build and edit custom commands")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "info") {
        const url = getGuildCommandsDashboardUrl(guildId);
        await ctx.interaction.reply({
          ...resultReply(
            "Build a custom command",
            "Custom commands are built on the dashboard: a name, a description, and a reply, either a message or an embed. Open the dashboard's Commands section for this server to get started.",
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_cmd:1544418082867384360>" }),
          ),
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton("Open commands dashboard", url))],
        });
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "dream_commands", "can_remove");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const deleted = await deleteDreamCommand(guildId, name);
        if (!deleted) {
          await ctx.interaction.reply(
            resultReply("Not found", `No command named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        try {
          await syncGuildDreamSlashCommands(ctx.client, guildId);
        } catch (error) {
          console.error("[dream_commands] guild slash sync failed after remove:", error);
        }

        await ctx.interaction.reply(
          resultReply(
            "Command removed",
            `Removed **${deleted.name}** (\`${formatTriggerLabel(deleted)}\`).`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "toggle") {
        const auth = await requirePluginPermission(ctx, "dream_commands", "can_edit");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const existing = await getDreamCommand(guildId, name);
        if (!existing) {
          await ctx.interaction.reply(
            resultReply("Not found", `No command named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const updated = await updateDreamCommand(guildId, name, { enabled: !existing.enabled });
        if (!updated) return;

        try {
          await syncGuildDreamSlashCommands(ctx.client, guildId);
        } catch (error) {
          console.error("[dream_commands] guild slash sync failed after toggle:", error);
        }

        await ctx.interaction.reply(
          resultReply(
            updated.enabled ? "Command enabled" : "Command disabled",
            updated.enabled
              ? `**${updated.name}** (\`${formatTriggerLabel(updated)}\`) is live again.`
              : `**${updated.name}** is disabled and no longer registered on this server.`,
            ctx.ephemeral,
            slashResultOptions(ctx, updated.enabled ? { emoji: "<:icons_unlock:1544417749617610852>" } : undefined),
          ),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "dream_commands", "can_list");
        if (!auth) return;

        const rows = await listDreamCommands(guildId);
        if (!rows.length) {
          await ctx.interaction.reply(
            resultReply("Commands", "No custom commands configured yet.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const guildSlashIds = new Map<string, string>();
        try {
          const guildCmds = await ctx.interaction.guild!.commands.fetch();
          for (const cmd of guildCmds.values()) {
            guildSlashIds.set(cmd.name, cmd.id);
          }
        } catch (error) {
          console.warn("[dream_commands] failed to fetch guild slash ids for list:", error);
        }

        const lines = rows
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => {
            if (!row.enabled) {
              return `**${row.name}** · disabled`;
            }
            const id = guildSlashIds.get(row.name);
            const trigger = id ? `</${row.name}:${id}>` : `\`/${row.name}\``;
            return `**${row.name}** · ${trigger}`;
          });

        const embed = setEmbedAuthor(
          baseEmbed(),
          "Custom commands",
          ctx.client,
          commandHeader(ctx.guildConfig, { emoji: "<:icons_list:1544417562325164173>" }),
        ).setDescription(trimLines(lines.join("\n")));

        await ctx.interaction.reply({
          ...embedReply(embed, ctx.ephemeral),
          components: [listStatRow(rows.length)],
        });
      }
    },
  },
];
