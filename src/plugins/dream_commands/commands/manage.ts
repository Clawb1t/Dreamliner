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
import { getLogger } from "../../../core/logger.js";
import type { Translator } from "../../../i18n/index.js";
const log = getLogger("dream_commands");

function listStatRow(t: Translator, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("dl:dreamcmd:stat:total")
      .setLabel(t("dream_commands.statTotal", "{total}/{max} commands", { total, max: MAX_DREAM_COMMANDS }))
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
        await ctx.interaction.reply(
          resultReply(
            ctx.t("dream_commands.buildTitle", "Build a custom command"),
            ctx.t(
              "dream_commands.buildDescription",
              "Custom commands are built on the dashboard: a name, a description, and a reply, either a message or an embed. Open the dashboard's Commands section for this server to get started.",
            ),
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_cmd:1544418082867384360>" }),
            [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                linkButton(ctx.t("dream_commands.openDashboardButton", "Open commands dashboard"), url),
              ),
            ],
          ),
        );
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "dream_commands", "can_remove");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const deleted = await deleteDreamCommand(guildId, name);
        if (!deleted) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("dream_commands.notFoundTitle", "Not found"),
              ctx.t("dream_commands.notFoundBody", "No command named **{name}**.", { name }),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        try {
          await syncGuildDreamSlashCommands(ctx.client, guildId);
        } catch (error) {
          log.error("[dream_commands] guild slash sync failed after remove:", error);
        }

        await ctx.interaction.reply(
          resultReply(
            ctx.t("dream_commands.removedTitle", "Command removed"),
            ctx.t("dream_commands.removedBody", "Removed **{name}** (`{trigger}`).", {
              name: deleted.name,
              trigger: formatTriggerLabel(deleted),
            }),
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
            resultReply(
              ctx.t("dream_commands.notFoundTitle", "Not found"),
              ctx.t("dream_commands.notFoundBody", "No command named **{name}**.", { name }),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const updated = await updateDreamCommand(guildId, name, { enabled: !existing.enabled });
        if (!updated) return;

        try {
          await syncGuildDreamSlashCommands(ctx.client, guildId);
        } catch (error) {
          log.error("[dream_commands] guild slash sync failed after toggle:", error);
        }

        await ctx.interaction.reply(
          resultReply(
            updated.enabled
              ? ctx.t("dream_commands.enabledTitle", "Command enabled")
              : ctx.t("dream_commands.disabledTitle", "Command disabled"),
            updated.enabled
              ? ctx.t("dream_commands.enabledBody", "**{name}** (`{trigger}`) is live again.", {
                  name: updated.name,
                  trigger: formatTriggerLabel(updated),
                })
              : ctx.t(
                  "dream_commands.disabledBody",
                  "**{name}** is disabled and no longer registered on this server.",
                  { name: updated.name },
                ),
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
            resultReply(
              ctx.t("dream_commands.listTitle", "Commands"),
              ctx.t("dream_commands.listEmpty", "No custom commands configured yet."),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
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
          log.warn("[dream_commands] failed to fetch guild slash ids for list:", error);
        }

        const lines = rows
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => {
            if (!row.enabled) {
              return ctx.t("dream_commands.listRowDisabled", "**{name}** · disabled", { name: row.name });
            }
            const id = guildSlashIds.get(row.name);
            const trigger = id ? `</${row.name}:${id}>` : `\`/${row.name}\``;
            return ctx.t("dream_commands.listRowEnabled", "**{name}** · {trigger}", { name: row.name, trigger });
          });

        const embed = setEmbedAuthor(
          baseEmbed(),
          ctx.t("dream_commands.listTitle", "Commands"),
          ctx.client,
          commandHeader(ctx.guildConfig, { emoji: "<:icons_list:1544417562325164173>" }),
        ).setDescription(trimLines(lines.join("\n")));

        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral, [listStatRow(ctx.t, rows.length)]));
      }
    },
  },
];
