import { ChannelType, SlashCommandBuilder, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { requireMusicPermission, requirePlaybackControl, lineReply } from "../functions/commandHelpers.js";
import { configManager } from "../../../config/manager.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { logMusic } from "../functions/musicLog.js";

export const musicConfigCommand: SlashCommandDefinition = {
  plugin: "music",
  data: new SlashCommandBuilder()
    .setName("musicconfig")
    .setDescription("Configure server-wide music settings")
    .addSubcommand((sub) =>
      sub
        .setName("announce")
        .setDescription("Set (or turn off) the now-playing announce channel")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel, or omit to turn announcements off").addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((sub) => sub.setName("volume-default").setDescription("Set the default starting volume").addIntegerOption((o) => o.setName("percent").setDescription("Volume percent").setRequired(true).setMinValue(1).setMaxValue(150)))
    .addSubcommand((sub) => sub.setName("votethreshold").setDescription("Set the vote-skip percentage required").addIntegerOption((o) => o.setName("percent").setDescription("Percent (10-100)").setRequired(true).setMinValue(10).setMaxValue(100))),
  execute: async (ctx) => {
    const { interaction, ephemeral } = ctx;
    const guildId = interaction.guildId!;
    const auth = await requireMusicPermission(ctx, "can_manage_settings");
    if (!auth) return;
    const member = auth.member as GuildMember;
    if (!(await requirePlaybackControl(ctx, member, auth.config, auth.config.can_manage_settings))) return;

    const sub = interaction.options.getSubcommand(true);

    if (sub === "announce") {
      const channel = interaction.options.getChannel("channel");
      await configManager.patchPluginConfig(
        guildId,
        "music",
        { announce_now_playing: Boolean(channel), announce_channel_id: channel?.id ?? null },
        interaction.user.id,
      );
      const body = channel ? `Now-playing announcements will post in <#${channel.id}>.` : "Now-playing announcements are off.";
      await interaction.reply(lineReply(`${MUSIC_EMOJI.success} ${body}`, ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_settings", "Music - Announce Channel Changed", [
        `By: <@${interaction.user.id}>`,
        body,
      ], { actorId: interaction.user.id, channelId: channel?.id ?? null });
      return;
    }

    if (sub === "volume-default") {
      const percent = interaction.options.getInteger("percent", true);
      await configManager.patchPluginConfig(guildId, "music", { default_volume: percent }, interaction.user.id);
      await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Default volume set to **${percent}%**.`, ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_settings", "Music - Default Volume Changed", [
        `By: <@${interaction.user.id}>`,
        `Default volume set to **${percent}%**`,
      ], { actorId: interaction.user.id });
      return;
    }

    if (sub === "votethreshold") {
      const percent = interaction.options.getInteger("percent", true);
      await configManager.patchPluginConfig(guildId, "music", { vote_skip_threshold_percent: percent }, interaction.user.id);
      await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Vote-skip threshold set to **${percent}%**.`, ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_settings", "Music - Vote-Skip Threshold Changed", [
        `By: <@${interaction.user.id}>`,
        `Vote-skip threshold set to **${percent}%**`,
      ], { actorId: interaction.user.id });
    }
  },
};
