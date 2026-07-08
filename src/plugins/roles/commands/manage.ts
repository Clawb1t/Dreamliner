import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { canManageRole, safeAddRole, safeRemoveRole } from "../../../core/roles.js";

export const rolesCommands: SlashCommandDefinition[] = [
  {
    plugin: "roles",
    data: new SlashCommandBuilder()
      .setName("roles")
      .setDescription("Manage member roles")
      .addSubcommand((sub) =>
        sub
          .setName("give")
          .setDescription("Give a role to a member")
          .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
          .addRoleOption((o) => o.setName("role").setDescription("Role to give").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a role from a member")
          .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
          .addRoleOption((o) => o.setName("role").setDescription("Role to remove").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List a member's roles")
          .addUserOption((o) => o.setName("user").setDescription("Member (defaults to you)")),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();

      if (sub === "give") {
        const auth = await requirePluginPermission(ctx, "roles", "can_give");
        if (!auth) return;

        const user = ctx.interaction.options.getUser("user", true);
        const role = ctx.interaction.options.getRole("role", true);
        const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
        if (!member) {
          await ctx.interaction.reply(resultReply("Member not found", "Could not resolve that member.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const guildRole = ctx.interaction.guild!.roles.cache.get(role.id);
        if (!guildRole) {
          await ctx.interaction.reply(resultReply("Role not found", "Could not resolve that role.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        if (!canManageRole(auth.member, guildRole)) {
          await ctx.interaction.reply(resultReply("Permission denied", "You cannot manage that role.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const result = await safeAddRole(member, role.id, `Roles give by ${ctx.interaction.user.tag}`);
        if (!result.ok) {
          await ctx.interaction.reply(resultReply("Could not give role", result.reason, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await ctx.interaction.reply(
          resultReply("Role given", `Gave ${role} to ${user.tag}.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "roles", "can_remove");
        if (!auth) return;

        const user = ctx.interaction.options.getUser("user", true);
        const role = ctx.interaction.options.getRole("role", true);
        const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
        if (!member) {
          await ctx.interaction.reply(resultReply("Member not found", "Could not resolve that member.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const guildRole = ctx.interaction.guild!.roles.cache.get(role.id);
        if (!guildRole) {
          await ctx.interaction.reply(resultReply("Role not found", "Could not resolve that role.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        if (!canManageRole(auth.member, guildRole)) {
          await ctx.interaction.reply(resultReply("Permission denied", "You cannot manage that role.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const result = await safeRemoveRole(member, role.id, `Roles remove by ${ctx.interaction.user.tag}`);
        if (!result.ok) {
          await ctx.interaction.reply(resultReply("Could not remove role", result.reason, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await ctx.interaction.reply(
          resultReply("Role removed", `Removed ${role} from ${user.tag}.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "roles", "can_list");
        if (!auth) return;

        const user = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
        const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
        if (!member) {
          await ctx.interaction.reply(resultReply("Member not found", "Could not resolve that member.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const roles = member.roles.cache
          .filter((r) => r.id !== ctx.interaction.guildId)
          .sort((a, b) => b.position - a.position)
          .map((r) => r.toString())
          .join(", ");

        await ctx.interaction.reply(
          resultReply(
            `${user.tag}'s roles`,
            roles.length > 0 ? roles : "No roles.",
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
      }
    },
  },
];
