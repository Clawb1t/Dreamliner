import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { canManageRole } from "../../../core/roles.js";

export const pingableRoleCommands: SlashCommandDefinition[] = [
  {
    plugin: "pingable_roles",
    discordPermissions: PermissionFlagsBits.ManageRoles,
    data: new SlashCommandBuilder()
      .setName("pingrole")
      .setDescription("Toggle whether a role can be mentioned")
      .addSubcommand((sub) =>
        sub
          .setName("enable")
          .setDescription("Allow a role to be pinged")
          .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("disable")
          .setDescription("Prevent a role from being pinged")
          .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const permission = sub === "enable" ? "can_enable" : "can_disable";
      const auth = await requirePluginPermission(ctx, "pingable_roles", permission);
      if (!auth) return;

      const roleOpt = ctx.interaction.options.getRole("role", true);
      const role = ctx.interaction.guild!.roles.cache.get(roleOpt.id);
      if (!role) {
        await ctx.interaction.reply(
          resultReply("Role not found", "Could not resolve that role.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      if (!canManageRole(auth.member, role)) {
        await ctx.interaction.reply(
          resultReply("Permission denied", "You cannot manage that role.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const mentionable = sub === "enable";
      if (role.managed) {
        await ctx.interaction.reply(
          resultReply("Managed role", "Integration-managed roles cannot be changed.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      await role.setMentionable(mentionable, `Pingrole ${sub} by ${ctx.interaction.user.tag}`);

      await ctx.interaction.reply(
        resultReply(
          mentionable ? "Role pingable" : "Role not pingable",
          `${role} is now ${mentionable ? "mentionable" : "not mentionable"}.`,
          ctx.ephemeral,
          slashResultOptions(ctx),
        ),
      );
    },
  },
];
