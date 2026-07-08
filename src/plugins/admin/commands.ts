import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { zAdminConfig } from "../../config/schemas/plugins.js";
import { applyLockdown, applyUnlock } from "./functions/lockdown.js";

export const adminCommands: SlashCommandDefinition[] = [
  {
    plugin: "admin",
    discordPermissions: PermissionFlagsBits.ManageChannels,
    data: new SlashCommandBuilder().setName("lockdown").setDescription("Deny Send Messages in all text channels"),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "admin", "can_lockdown");
      if (!auth) return;

      const config = zAdminConfig.parse(auth.pluginConfig);
      const guild = ctx.interaction.guild!;
      const { updated, target } = await applyLockdown(guild, config);

      await ctx.interaction.reply(
        resultReply(
          "Lockdown enabled",
          `Denied **Send Messages** for **${target}** in **${updated}** text channel(s).`,
          ctx.ephemeral,
          slashResultOptions(ctx),
        ),
      );
    },
  },
  {
    plugin: "admin",
    discordPermissions: PermissionFlagsBits.ManageChannels,
    data: new SlashCommandBuilder().setName("unlock").setDescription("Restore Send Messages in text channels"),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "admin", "can_unlock");
      if (!auth) return;

      const config = zAdminConfig.parse(auth.pluginConfig);
      const guild = ctx.interaction.guild!;
      const { updated, target } = await applyUnlock(guild, config);

      await ctx.interaction.reply(
        resultReply(
          "Lockdown lifted",
          `Restored **Send Messages** for **${target}** in **${updated}** text channel(s).`,
          ctx.ephemeral,
          slashResultOptions(ctx),
        ),
      );
    },
  },
];
