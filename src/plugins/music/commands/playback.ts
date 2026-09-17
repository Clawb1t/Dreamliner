import { SlashCommandBuilder, type GuildMember, type VoiceBasedChannel } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { MUSIC_FILTER_PRESETS } from "../../../config/schemas/music.js";
import { containersReply } from "../../../core/responses.js";
import { requireMusicPermission, requireActivePlayer, requirePlaybackControl, memberSharesVoiceChannel, lineReply } from "../functions/commandHelpers.js";
import { canBypassVoteSkip } from "../functions/permissions.js";
import { registerVote, requiredVotes, clearVotes } from "../functions/voteSkip.js";
import { applyFilterPreset } from "../functions/filters.js";
import { destroyPlayer } from "../functions/player.js";
import {
  skippedLine,
  stoppedLine,
  pausedLine,
  resumedLine,
  volumeLine,
  seekLine,
  buildTrackContainer,
  buildWebPlayerAnnounceContainer,
  nothingPlayingLine,
  formatDuration,
} from "../functions/formatting.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { saveSessionNow } from "../functions/sessionPersistence.js";
import { markWebPlayerAnnounced } from "../functions/webPlayerAnnounce.js";
import { logMusic } from "../functions/musicLog.js";

function parseSeekPosition(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

export const playbackCommands: SlashCommandDefinition[] = [
  {
    plugin: "music",
    data: new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const guildId = interaction.guildId!;
      const auth = await requireMusicPermission(ctx, "can_skip");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, guildId);
      if (!player) return;

      const member = auth.member as GuildMember;
      if (!memberSharesVoiceChannel(member, player)) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} You need to be in the voice channel to skip.`, ephemeral));
        return;
      }

      const current = player.queue.current;
      const requesterId = (current?.requester as { id?: string } | undefined)?.id;
      const canForceSkip = auth.config.can_force_skip;
      const bypass = canBypassVoteSkip(member, auth.config, canForceSkip) || requesterId === member.id;

      if (bypass) {
        clearVotes(guildId);
        await player.skip();
        await interaction.reply(lineReply(skippedLine(current), ephemeral));
        void logMusic(interaction.client, ctx.guildConfig, guildId, "music_skip", "Music — Track Skipped", [
          `By: <@${interaction.user.id}>`,
          current ? `Track: **${current.info.title}**${current.info.author ? ` — ${current.info.author}` : ""}` : "Track: (none)",
          "Method: Direct skip",
        ], { actorId: interaction.user.id });
        return;
      }

      const channel = member.voice.channel as VoiceBasedChannel | null;
      const nonBotCount = channel ? channel.members.filter((m) => !m.user.bot).size : 1;
      const need = requiredVotes(nonBotCount, auth.config.vote_skip_threshold_percent);
      const result = registerVote(guildId, current?.encoded, member.id, need, auth.config.vote_skip_timeout_seconds * 1000);

      if (result.status === "skipped") {
        await player.skip();
        await interaction.reply(lineReply(`${MUSIC_EMOJI.vote} Vote passed — ${skippedLine(current)}`, ephemeral));
        void logMusic(interaction.client, ctx.guildConfig, guildId, "music_skip", "Music — Track Skipped", [
          `By: <@${interaction.user.id}>`,
          current ? `Track: **${current.info.title}**${current.info.author ? ` — ${current.info.author}` : ""}` : "Track: (none)",
          `Method: Vote passed (${need} needed)`,
        ], { actorId: interaction.user.id });
        return;
      }
      if (result.status === "already_voted") {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.vote} You've already voted (${result.have}/${result.need}).`, ephemeral));
        return;
      }
      await interaction.reply(
        lineReply(`${MUSIC_EMOJI.vote} Vote to skip: **${result.have}/${result.need}**.`, ephemeral),
      );
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder().setName("stop").setDescription("Stop playback and leave the voice channel"),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const guildId = interaction.guildId!;
      const auth = await requireMusicPermission(ctx, "can_control_playback");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, guildId);
      if (!player) return;
      const member = auth.member as GuildMember;
      const canControl = auth.config.can_control_playback;
      if (!(await requirePlaybackControl(ctx, member, auth.config, canControl))) return;

      clearVotes(guildId);
      await destroyPlayer(guildId, "stopped via /stop");
      await interaction.reply(lineReply(stoppedLine(), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_stop", "Music — Playback Stopped", [
        `By: <@${interaction.user.id}>`,
        "Source: Discord (/stop)",
      ], { actorId: interaction.user.id });
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder().setName("pause").setDescription("Pause the current track"),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_control_playback");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, interaction.guildId!);
      if (!player) return;
      const member = auth.member as GuildMember;
      const canControl = auth.config.can_control_playback;
      if (!(await requirePlaybackControl(ctx, member, auth.config, canControl))) return;

      await player.pause();
      void saveSessionNow(player).catch(() => {});
      await interaction.reply(lineReply(pausedLine(), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, interaction.guildId!, "music_playback", "Music — Paused", [
        `By: <@${interaction.user.id}>`,
      ], { actorId: interaction.user.id });
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder().setName("resume").setDescription("Resume the current track"),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_control_playback");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, interaction.guildId!);
      if (!player) return;
      const member = auth.member as GuildMember;
      const canControl = auth.config.can_control_playback;
      if (!(await requirePlaybackControl(ctx, member, auth.config, canControl))) return;

      await player.resume();
      void saveSessionNow(player).catch(() => {});
      await interaction.reply(lineReply(resumedLine(), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, interaction.guildId!, "music_playback", "Music — Resumed", [
        `By: <@${interaction.user.id}>`,
      ], { actorId: interaction.user.id });
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder()
      .setName("volume")
      .setDescription("Set the playback volume")
      .addIntegerOption((o) => o.setName("percent").setDescription("Volume percent (0-150)").setMinValue(0).setMaxValue(150).setRequired(true)),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_control_playback");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, interaction.guildId!);
      if (!player) return;
      const member = auth.member as GuildMember;
      const canControl = auth.config.can_control_playback;
      if (!(await requirePlaybackControl(ctx, member, auth.config, canControl))) return;

      const percent = interaction.options.getInteger("percent", true);
      await player.setVolume(percent);
      void saveSessionNow(player).catch(() => {});
      await interaction.reply(lineReply(volumeLine(percent), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, interaction.guildId!, "music_playback", "Music — Volume Changed", [
        `By: <@${interaction.user.id}>`,
        `Volume set to **${percent}%**`,
      ], { actorId: interaction.user.id });
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder()
      .setName("seek")
      .setDescription("Seek to a position in the current track")
      .addStringOption((o) => o.setName("position").setDescription("Position, e.g. 1:30 or 90").setRequired(true)),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_control_playback");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, interaction.guildId!);
      if (!player) return;
      const member = auth.member as GuildMember;
      const canControl = auth.config.can_control_playback;
      if (!(await requirePlaybackControl(ctx, member, auth.config, canControl))) return;

      const current = player.queue.current;
      if (!current) {
        await interaction.reply(lineReply(nothingPlayingLine(), ephemeral));
        return;
      }
      const raw = interaction.options.getString("position", true);
      const ms = parseSeekPosition(raw);
      if (ms === null || ms < 0 || ms > current.info.duration) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Give a position like \`1:30\` within the track's length.`, ephemeral));
        return;
      }
      await player.seek(ms);
      void saveSessionNow(player).catch(() => {});
      await interaction.reply(lineReply(seekLine(ms, current.info.duration), ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, interaction.guildId!, "music_playback", "Music — Seeked", [
        `By: <@${interaction.user.id}>`,
        `Seeked to **${formatDuration(ms)} / ${formatDuration(current.info.duration)}**`,
      ], { actorId: interaction.user.id });
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder().setName("nowplaying").setDescription("Show what's currently playing"),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_play");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, interaction.guildId!);
      if (!player) return;

      const current = player.queue.current;
      if (!current) {
        await interaction.reply(lineReply(nothingPlayingLine(), ephemeral));
        return;
      }
      const guildId = interaction.guildId!;
      const trackEntry = buildTrackContainer(current, {
        kind: player.paused ? "paused" : "now_playing",
        positionMs: player.position,
      });
      markWebPlayerAnnounced(guildId);
      await interaction.reply(containersReply([trackEntry, buildWebPlayerAnnounceContainer(guildId)], ephemeral));
    },
  },
  {
    plugin: "music",
    data: new SlashCommandBuilder()
      .setName("filter")
      .setDescription("Apply an audio filter preset")
      .addStringOption((o) =>
        o
          .setName("preset")
          .setDescription("Filter preset")
          .setRequired(true)
          .addChoices(...MUSIC_FILTER_PRESETS.map((p) => ({ name: p, value: p }))),
      ),
    execute: async (ctx) => {
      const { interaction, ephemeral } = ctx;
      const auth = await requireMusicPermission(ctx, "can_control_playback");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, interaction.guildId!);
      if (!player) return;
      const member = auth.member as GuildMember;
      const canControl = auth.config.can_control_playback;
      if (!(await requirePlaybackControl(ctx, member, auth.config, canControl))) return;

      const preset = interaction.options.getString("preset", true) as (typeof MUSIC_FILTER_PRESETS)[number];
      if (!auth.config.allowed_filters.includes(preset)) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} That filter preset is disabled on this server.`, ephemeral));
        return;
      }
      await applyFilterPreset(player, preset);
      await interaction.reply(lineReply(`${MUSIC_EMOJI.music} Filter set to **${preset}**.`, ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, interaction.guildId!, "music_filter", "Music — Filter Changed", [
        `By: <@${interaction.user.id}>`,
        `Filter set to **${preset}**`,
      ], { actorId: interaction.user.id });
    },
  },
];
