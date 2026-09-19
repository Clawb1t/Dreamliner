import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { requireMusicPermission, lineEdit } from "../functions/commandHelpers.js";
import { configManager } from "../../../config/manager.js";
import { getConnectedPlayer } from "../functions/player.js";
import { ensureAutoplayQueueDepth } from "../functions/autoplay.js";
import { deferReplyOptions } from "../../../core/responses.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { logMusic } from "../functions/musicLog.js";

export const autoplayCommand: SlashCommandDefinition = {
  plugin: "music",
  data: new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Toggle autoplay: queue a similar track whenever the queue runs out")
    .addBooleanOption((o) => o.setName("enabled").setDescription("On or off").setRequired(true)),
  execute: async (ctx) => {
    const { interaction, ephemeral } = ctx;
    const guildId = interaction.guildId!;
    const auth = await requireMusicPermission(ctx, "can_autoplay");
    if (!auth) return;

    await interaction.deferReply(deferReplyOptions(ephemeral));

    const enabled = interaction.options.getBoolean("enabled", true);
    await configManager.patchPluginConfig(guildId, "music", { autoplay_enabled: enabled }, interaction.user.id);

    // Without this, turning autoplay on would only start topping up the queue once the current
    // track ends on its own - leaving nothing to /skip to right now if the queue is already short.
    let addedNow = 0;
    if (enabled) {
      const player = getConnectedPlayer(guildId);
      if (player) addedNow = await ensureAutoplayQueueDepth(interaction.client, player, ctx.guildConfig);
    }

    await interaction.editReply(
      lineEdit(
        `${MUSIC_EMOJI.success} Autoplay is now **${enabled ? "on" : "off"}**.${
          enabled ? " I'll keep the queue topped up with similar tracks." : ""
        }${addedNow > 0 ? ` Queued ${addedNow} track${addedNow === 1 ? "" : "s"} now.` : ""}`,
      ),
    );
    void logMusic(interaction.client, ctx.guildConfig, guildId, "music_settings", "Music - Autoplay Changed", [
      `By: <@${interaction.user.id}>`,
      `Autoplay is now **${enabled ? "on" : "off"}**`,
    ], { actorId: interaction.user.id });
  },
};
