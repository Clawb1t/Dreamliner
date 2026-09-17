import { SlashCommandBuilder, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { MUSIC_LOOP_MODES } from "../../../config/schemas/music.js";
import { requireMusicPermission, requireActivePlayer, requirePlaybackControl, lineReply } from "../functions/commandHelpers.js";
import { removeAt, move, clearQueue } from "../functions/queueOps.js";
import { formatDuration, trackLink, loopLine, shuffledLine, nothingPlayingLine } from "../functions/formatting.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { saveSessionNow } from "../functions/sessionPersistence.js";
import { logMusic } from "../functions/musicLog.js";

const PAGE_SIZE = 10;

export const queueCommands: SlashCommandDefinition[] = [
  {
    plugin: "music",
    data: new SlashCommandBuilder()
      .setName("queue")
      .setDescription("View or manage the queue")
      .addSubcommand((sub) => sub.setName("view").setDescription("Show the upcoming queue").addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1)))
      .addSubcommand((sub) =>
        sub.setName("remove").setDescription("Remove a track from the queue").addIntegerOption((o) => o.setName("position").setDescription("Position in queue (1-based)").setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("move")
          .setDescription("Move a track to a different position")
          .addIntegerOption((o) => o.setName("from").setDescription("Current position").setRequired(true).setMinValue(1))
          .addIntegerOption((o) => o.setName("to").setDescription("New position").setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) => sub.setName("clear").setDescription("Clear the entire queue")),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const sub = interaction.options.getSubcommand(true);
      const guildId = interaction.guildId!;

      if (sub === "view") {
        const auth = await requireMusicPermission(ctx, "can_play");
        if (!auth) return;
        const player = await requireActivePlayer(ctx, guildId);
        if (!player) return;

        const tracks = player.queue.tracks;
        if (!player.queue.current && tracks.length === 0) {
          await interaction.reply(lineReply(nothingPlayingLine(), ephemeral));
          return;
        }

        const page = interaction.options.getInteger("page") ?? 1;
        const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
        const clampedPage = Math.min(Math.max(1, page), totalPages);
        const start = (clampedPage - 1) * PAGE_SIZE;
        const slice = tracks.slice(start, start + PAGE_SIZE);

        const lines: string[] = [];
        if (player.queue.current) {
          lines.push(`${MUSIC_EMOJI.play} **Now:** ${trackLink(player.queue.current)}`);
        }
        if (slice.length === 0) {
          lines.push("Queue is empty.");
        } else {
          for (const [i, track] of slice.entries()) {
            const title = "resolve" in track ? track.info.title : trackLink(track);
            lines.push(`\`${start + i + 1}.\` ${title}`);
          }
        }
        const totalDuration = tracks.reduce((sum, t) => sum + (t.info.duration ?? 0), 0);
        lines.push(`-# ${tracks.length} track${tracks.length === 1 ? "" : "s"} queued · ${formatDuration(totalDuration)} · page ${clampedPage}/${totalPages}`);
        await interaction.reply(lineReply(lines.join("\n"), ephemeral));
        return;
      }

      const auth = await requireMusicPermission(ctx, "can_manage_queue");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, guildId);
      if (!player) return;
      const member = auth.member as GuildMember;
      if (!(await requirePlaybackControl(ctx, member, auth.config, auth.config.can_manage_queue))) return;

      if (sub === "remove") {
        const position = interaction.options.getInteger("position", true);
        const result = await removeAt(player, position);
        if (!result.ok) {
          await interaction.reply(lineReply(`${MUSIC_EMOJI.error} No track at position ${position}.`, ephemeral));
          return;
        }
        void saveSessionNow(player).catch(() => {});
        await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Removed **${result.title}** from the queue.`, ephemeral));
        void logMusic(interaction.client, ctx.guildConfig, guildId, "music_queue", "Music — Queue Track Removed", [
          `By: <@${interaction.user.id}>`,
          `Removed **${result.title}** (position #${position})`,
        ], { actorId: interaction.user.id });
        return;
      }

      if (sub === "move") {
        const from = interaction.options.getInteger("from", true);
        const to = interaction.options.getInteger("to", true);
        const result = await move(player, from, to);
        if (!result.ok) {
          await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Invalid position.`, ephemeral));
          return;
        }
        void saveSessionNow(player).catch(() => {});
        await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Moved track from #${from} to #${to}.`, ephemeral));
        void logMusic(interaction.client, ctx.guildConfig, guildId, "music_queue", "Music — Queue Track Moved", [
          `By: <@${interaction.user.id}>`,
          `Moved track from #${from} to #${to}`,
        ], { actorId: interaction.user.id });
        return;
      }

      if (sub === "clear") {
        const count = await clearQueue(player);
        void saveSessionNow(player).catch(() => {});
        await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Cleared **${count}** track${count === 1 ? "" : "s"} from the queue.`, ephemeral));
        void logMusic(interaction.client, ctx.guildConfig, guildId, "music_queue", "Music — Queue Cleared", [
          `By: <@${interaction.user.id}>`,
          `Cleared **${count}** track${count === 1 ? "" : "s"}`,
        ], { actorId: interaction.user.id });
      }
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the queue"),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_manage_queue");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, interaction.guildId!);
      if (!player) return;
      const member = auth.member as GuildMember;
      if (!(await requirePlaybackControl(ctx, member, auth.config, auth.config.can_manage_queue))) return;

      const count = await player.queue.shuffle();
      void saveSessionNow(player).catch(() => {});
      await interaction.reply(lineReply(shuffledLine(count), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, interaction.guildId!, "music_queue", "Music — Queue Shuffled", [
        `By: <@${interaction.user.id}>`,
        `Shuffled **${count}** track${count === 1 ? "" : "s"}`,
      ], { actorId: interaction.user.id });
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder()
      .setName("loop")
      .setDescription("Set the loop mode")
      .addStringOption((o) => o.setName("mode").setDescription("Loop mode").setRequired(true).addChoices(...MUSIC_LOOP_MODES.map((m) => ({ name: m, value: m })))),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_manage_queue");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, interaction.guildId!);
      if (!player) return;
      const member = auth.member as GuildMember;
      if (!(await requirePlaybackControl(ctx, member, auth.config, auth.config.can_manage_queue))) return;

      const mode = interaction.options.getString("mode", true) as (typeof MUSIC_LOOP_MODES)[number];
      await player.setRepeatMode(mode);
      void saveSessionNow(player).catch(() => {});
      await interaction.reply(lineReply(loopLine(mode), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, interaction.guildId!, "music_queue", "Music — Loop Mode Changed", [
        `By: <@${interaction.user.id}>`,
        `Loop mode set to **${mode}**`,
      ], { actorId: interaction.user.id });
    },
  },
];
