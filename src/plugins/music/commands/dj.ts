import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { requireMusicPermission, lineReply } from "../functions/commandHelpers.js";
import { configManager } from "../../../config/manager.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { logMusic } from "../functions/musicLog.js";

export const djCommand: SlashCommandDefinition = {
  plugin: "music",
  data: new SlashCommandBuilder()
    .setName("dj")
    .setDescription("Manage DJ roles and DJ mode")
    .addSubcommandGroup((group) =>
      group
        .setName("role")
        .setDescription("Manage which roles count as DJ")
        .addSubcommand((sub) => sub.setName("add").setDescription("Add a DJ role").addRoleOption((o) => o.setName("role").setDescription("Role to add").setRequired(true)))
        .addSubcommand((sub) => sub.setName("remove").setDescription("Remove a DJ role").addRoleOption((o) => o.setName("role").setDescription("Role to remove").setRequired(true)))
        .addSubcommand((sub) => sub.setName("list").setDescription("List current DJ roles")),
    )
    .addSubcommand((sub) =>
      sub.setName("mode").setDescription("Toggle DJ mode (only DJs can control playback)").addBooleanOption((o) => o.setName("enabled").setDescription("On or off").setRequired(true)),
    ),
  execute: async (ctx) => {
    const { interaction, ephemeral } = ctx;
    const guildId = interaction.guildId!;
    const auth = await requireMusicPermission(ctx, "can_manage_dj");
    if (!auth) return;

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);

    if (group === "role") {
      const roles = new Set(auth.config.dj_roles);
      if (sub === "add") {
        const role = interaction.options.getRole("role", true);
        roles.add(role.id);
        await configManager.patchPluginConfig(guildId, "music", { dj_roles: [...roles] }, interaction.user.id);
        await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Added <@&${role.id}> as a DJ role.`, ephemeral));
        void logMusic(interaction.client, ctx.guildConfig, guildId, "music_dj", "Music — DJ Role Added", [
          `By: <@${interaction.user.id}>`,
          `Added <@&${role.id}> as a DJ role`,
        ], { actorId: interaction.user.id, targetId: role.id });
        return;
      }
      if (sub === "remove") {
        const role = interaction.options.getRole("role", true);
        roles.delete(role.id);
        await configManager.patchPluginConfig(guildId, "music", { dj_roles: [...roles] }, interaction.user.id);
        await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Removed <@&${role.id}> as a DJ role.`, ephemeral));
        void logMusic(interaction.client, ctx.guildConfig, guildId, "music_dj", "Music — DJ Role Removed", [
          `By: <@${interaction.user.id}>`,
          `Removed <@&${role.id}> as a DJ role`,
        ], { actorId: interaction.user.id, targetId: role.id });
        return;
      }
      // list
      const list = [...roles];
      const body = list.length ? list.map((id) => `<@&${id}>`).join(", ") : "No DJ roles set.";
      await interaction.reply(lineReply(`${MUSIC_EMOJI.mic} DJ roles: ${body}`, ephemeral));
      return;
    }

    if (sub === "mode") {
      const enabled = interaction.options.getBoolean("enabled", true);
      await configManager.patchPluginConfig(guildId, "music", { dj_mode: enabled }, interaction.user.id);
      await interaction.reply(lineReply(`${MUSIC_EMOJI.success} DJ mode is now **${enabled ? "on" : "off"}**.`, ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_dj", "Music — DJ Mode Changed", [
        `By: <@${interaction.user.id}>`,
        `DJ mode is now **${enabled ? "on" : "off"}**`,
      ], { actorId: interaction.user.id });
    }
  },
};
