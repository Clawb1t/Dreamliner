import { SlashCommandBuilder, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { requireMusicPermission, requireActivePlayer, requirePlaybackControl, lineReply } from "../functions/commandHelpers.js";
import { getOrConnectPlayer, destroyPlayer } from "../functions/player.js";
import { isLavalinkConfigured } from "../functions/manager.js";
import { blockedByMessage } from "../../../core/voiceSessionRegistry.js";
import { configManager } from "../../../config/manager.js";
import { joinedLine, leftLine } from "../functions/formatting.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { logMusic } from "../functions/musicLog.js";

export const connectCommands: SlashCommandDefinition[] = [
  {
    plugin: "music",
    data: new SlashCommandBuilder().setName("join").setDescription("Join your voice channel without playing anything"),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_play");
      if (!auth) return;

      if (!isLavalinkConfigured()) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Music isn't configured on this bot yet.`, ephemeral));
        return;
      }

      const member = auth.member as GuildMember;
      const voiceChannelId = member.voice.channelId;
      if (!voiceChannelId) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Join a voice channel first.`, ephemeral));
        return;
      }

      const claim = await getOrConnectPlayer(interaction.guildId!, voiceChannelId, interaction.channelId);
      if (!claim.ok) {
        const body = claim.reason === "blocked_by_other" ? blockedByMessage("music", claim.ownedBy) : "Couldn't connect to that voice channel.";
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} ${body}`, ephemeral));
        return;
      }
      await interaction.reply(lineReply(joinedLine(), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, interaction.guildId!, "music_session", "Music - Joined Voice", [
        `By: <@${interaction.user.id}>`,
        `Channel: <#${voiceChannelId}>`,
      ], { actorId: interaction.user.id, channelId: voiceChannelId });
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder().setName("leave").setDescription("Stop playback and leave the voice channel"),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const guildId = interaction.guildId!;
      const auth = await requireMusicPermission(ctx, "can_control_playback");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, guildId);
      if (!player) return;
      const member = auth.member as GuildMember;
      if (!(await requirePlaybackControl(ctx, member, auth.config, auth.config.can_control_playback))) return;

      await destroyPlayer(guildId, "left via /leave");
      await interaction.reply(lineReply(leftLine(), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_stop", "Music - Left Voice", [
        `By: <@${interaction.user.id}>`,
        "Source: Discord (/leave)",
      ], { actorId: interaction.user.id });
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder()
      .setName("247")
      .setDescription("Toggle 24/7 mode (stay connected even when the queue is empty)")
      .addBooleanOption((o) => o.setName("enabled").setDescription("On or off").setRequired(true)),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const guildId = interaction.guildId!;
      const auth = await requireMusicPermission(ctx, "can_manage_settings");
      if (!auth) return;
      const member = auth.member as GuildMember;
      if (!(await requirePlaybackControl(ctx, member, auth.config, auth.config.can_manage_settings))) return;

      const enabled = interaction.options.getBoolean("enabled", true);
      await configManager.patchPluginConfig(guildId, "music", { stay_connected_247: enabled }, interaction.user.id);
      await interaction.reply(
        lineReply(`${MUSIC_EMOJI.success} 24/7 mode is now **${enabled ? "on" : "off"}**.`, ephemeral),
      );
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_settings", "Music - 24/7 Mode Changed", [
        `By: <@${interaction.user.id}>`,
        `24/7 mode is now **${enabled ? "on" : "off"}**`,
      ], { actorId: interaction.user.id });
    },
  },
];
