import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import {
  createCommandAlias,
  deleteCommandAlias,
  getCommandAlias,
  listCommandAliases,
  parseAliasOptionsJson,
} from "../functions/store.js";
import { runStoredAlias } from "../functions/run.js";

export const aliasCommands: SlashCommandDefinition[] = [
  {
    plugin: "command_aliases",
    data: new SlashCommandBuilder()
      .setName("alias")
      .setDescription("Manage command aliases")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create or update an alias")
          .addStringOption((o) => o.setName("name").setDescription("Alias name").setRequired(true))
          .addStringOption((o) => o.setName("command").setDescription("Target slash command name").setRequired(true))
          .addStringOption((o) => o.setName("options").setDescription("JSON object of preset options")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete an alias")
          .addStringOption((o) => o.setName("name").setDescription("Alias name").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List command aliases"))
      .addSubcommand((sub) =>
        sub
          .setName("run")
          .setDescription("Run a saved alias")
          .addStringOption((o) => o.setName("name").setDescription("Alias name").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "command_aliases", "can_create");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true).trim();
        const command = ctx.interaction.options.getString("command", true).trim();
        const optionsRaw = ctx.interaction.options.getString("options") ?? "{}";

        let options: Record<string, unknown>;
        try {
          options = parseAliasOptionsJson(optionsRaw);
        } catch {
          await ctx.interaction.reply(
            resultReply("Alias", "Options must be valid JSON object.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const alias = await createCommandAlias({ guildId, name, command, options });
        await ctx.interaction.reply(
          resultReply(
            "Alias saved",
            `**${alias.name}** → \`/${alias.command}\` with \`${JSON.stringify(alias.options)}\`.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "command_aliases", "can_delete");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const deleted = await deleteCommandAlias(guildId, name);
        await ctx.interaction.reply(
          resultReply(
            deleted ? "Alias deleted" : "Not found",
            deleted ? `Removed **${name.toLowerCase()}**.` : `No alias named **${name}**.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "command_aliases", "can_list");
        if (!auth) return;

        const aliases = await listCommandAliases(guildId);
        if (!aliases.length) {
          await ctx.interaction.reply(resultReply("Aliases", "No command aliases configured.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const lines = aliases.map((alias) => `**${alias.name}** → \`/${alias.command}\` · \`${JSON.stringify(alias.options)}\``);
        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Command aliases", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("Aliases", trimLines(lines.join("\n"))),
            ),
            ctx.ephemeral,
          ),
        );
        return;
      }

      if (sub === "run") {
        const auth = await requirePluginPermission(ctx, "command_aliases", "can_run");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const alias = await getCommandAlias(guildId, name);
        if (!alias) {
          await ctx.interaction.reply(
            resultReply("Alias", `No alias named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const ran = await runStoredAlias(ctx, alias.command, alias.options);
        if (!ran) {
          await ctx.interaction.reply(
            resultReply("Alias", `Target command \`/${alias.command}\` was not found.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
        }
      }
    },
  },
];
