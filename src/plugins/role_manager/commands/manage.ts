import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { createManagedRole, deleteManagedRole, getManagedRole, listManagedRoles } from "../functions/store.js";

export const roleManagerCommands: SlashCommandDefinition[] = [
  {
    plugin: "role_manager",
    data: new SlashCommandBuilder()
      .setName("rolemanage")
      .setDescription("Manage role templates")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create a managed role template")
          .addStringOption((o) => o.setName("name").setDescription("Template name").setRequired(true))
          .addStringOption((o) => o.setName("template").setDescription("Role name template (supports {user}, etc.)").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a managed role template")
          .addStringOption((o) => o.setName("name").setDescription("Template name").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List managed role templates")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "role_manager", "can_create");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true).trim();
        const template = ctx.interaction.options.getString("template", true).trim();

        if (!name || !template) {
          await ctx.interaction.reply(
            resultReply("Invalid input", "Name and template are required.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const existing = await getManagedRole(guildId, name);
        if (existing) {
          await ctx.interaction.reply(
            resultReply("Already exists", `A template named **${name}** already exists.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
          );
          return;
        }

        const record = await createManagedRole(guildId, name, template);
        await ctx.interaction.reply(
          resultReply(
            "Template created",
            `#${record.id} **${name}** → \`${template}\``,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "role_manager", "can_delete");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true).trim();
        const deleted = await deleteManagedRole(guildId, name);
        if (!deleted) {
          await ctx.interaction.reply(
            resultReply("Not found", `No template named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await ctx.interaction.reply(
          resultReply("Template deleted", `Removed **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "role_manager", "can_list");
        if (!auth) return;

        const rows = await listManagedRoles(guildId);
        if (rows.length === 0) {
          await ctx.interaction.reply(
            resultReply("Managed roles", "No templates configured.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const lines = rows.map((r) => `#${r.id} **${r.name}** · \`${r.template}\``).join("\n");
        await ctx.interaction.reply(
          resultReply("Managed roles", lines, ctx.ephemeral, slashResultOptions(ctx)),
        );
      }
    },
  },
];
