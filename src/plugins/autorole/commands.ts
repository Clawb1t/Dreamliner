import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { zAutoroleConfig } from "../../config/schemas/autorole.js";
import { buildAutoroleAddModal } from "./functions/modal.js";
import { formatAutoroleEntry, getStoredAutoroleEntries, serializeAutoroleRoles } from "./functions/rules.js";

export const autoroleCommands: SlashCommandDefinition[] = [
  {
    plugin: "autorole",
    data: new SlashCommandBuilder()
      .setName("autorole")
      .setDescription("Configure roles assigned when members join")
      .addSubcommand((sub) => sub.setName("add").setDescription("Open a form to add an autorole"))
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a role from the autorole list")
          .addRoleOption((o) =>
            o.setName("role").setDescription("Role to stop assigning on join").setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List configured autoroles")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "add") {
        const auth = await requirePluginPermission(ctx, "autorole", "can_add");
        if (!auth) return;

        await ctx.interaction.showModal(buildAutoroleAddModal());
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "autorole", "can_remove");
        if (!auth) return;

        const role = ctx.interaction.options.getRole("role", true);
        const config = zAutoroleConfig.parse(auth.pluginConfig);
        const entries = getStoredAutoroleEntries(config);
        const filtered = entries.filter((entry) => entry.roleId !== role.id);

        if (filtered.length === entries.length) {
          await ctx.interaction.reply(
            resultReply(
              "Not found",
              `<@&${role.id}> is not in the autorole list.`,
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "autorole",
          { roles: serializeAutoroleRoles(filtered) },
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(
            resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await ctx.interaction.reply(
          resultReply(
            "Autorole removed",
            `Removed <@&${role.id}> from the autorole list.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "autorole", "can_list");
        if (!auth) return;

        const config = zAutoroleConfig.parse(auth.pluginConfig);
        const entries = getStoredAutoroleEntries(config);
        if (!entries.length) {
          await ctx.interaction.reply(
            resultReply("Autoroles", "No autoroles configured.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const lines = entries.map((entry) => formatAutoroleEntry(entry.roleId, entry));

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Autoroles", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("Roles", trimLines(lines.join("\n"))),
            ),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
