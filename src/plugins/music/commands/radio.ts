import { SlashCommandBuilder, type AutocompleteInteraction, type GuildMember, type VoiceBasedChannel } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { getLogger } from "../../../core/logger.js";
import { deferReplyOptions } from "../../../core/responses.js";
import { blockedByMessage } from "../../../core/voiceSessionRegistry.js";
import { getGuildMusicPlayerUrl } from "../../../core/docsUrl.js";
import { getOrConnectPlayer, getConnectedPlayer } from "../functions/player.js";
import { isLavalinkConfigured } from "../functions/manager.js";
import { musicChannelBlock } from "../functions/limits.js";
import { requireMusicPermission, requireActivePlayer, memberSharesVoiceChannel, lineReply, lineEdit } from "../functions/commandHelpers.js";
import { canBypassVoteSkip } from "../functions/permissions.js";
import { registerVote, requiredVotes, clearVotes } from "../functions/voteSkip.js";
import { formatDuration } from "../functions/formatting.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { saveSessionNow } from "../functions/sessionPersistence.js";
import { logMusic } from "../functions/musicLog.js";
import { getLive, liveStations } from "../radio/clock.js";
import { leaveRadio, listenerCounts, tuneIn } from "../radio/controller.js";
import { currentStationId } from "../radio/tags.js";

const RADIO = "📻";
const log = getLogger("music");

function nowLine(stationId: string): string | null {
  const live = getLive(stationId);
  if (!live) return null;
  const song = live.track.artist ? `${live.track.title} by ${live.track.artist}` : live.track.title;
  return `${RADIO} **${live.station.name}** · ${song} \`${formatDuration(live.offsetMs)} / ${formatDuration(live.track.durationMs)}\``;
}

/** Live stations matching what's typed, for /radio play station:. */
export async function handleRadioAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase().trim();
  const choices = liveStations()
    .filter((s) => !typed || s.name.toLowerCase().includes(typed) || (s.genre ?? "").toLowerCase().includes(typed))
    .slice(0, 25)
    .map((s) => ({ name: (s.genre ? `${s.name} · ${s.genre}` : s.name).slice(0, 100), value: s.id }));
  await interaction.respond(choices);
}

export const radioCommand: SlashCommandDefinition = {
  plugin: "music",
  data: new SlashCommandBuilder()
    .setName("radio")
    .setDescription("Tune into a Dreamliner radio station")
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("Tune into a station in your voice channel")
        .addStringOption((o) => o.setName("station").setDescription("The station to tune into").setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((sub) => sub.setName("leave").setDescription("Leave the station that's on air"))
    .addSubcommand((sub) => sub.setName("list").setDescription("See every station and what's playing"))
    .addSubcommand((sub) => sub.setName("nowplaying").setDescription("See what the station on air is playing")),
  execute: async (ctx) => {
    const { interaction, ephemeral } = ctx;
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand(true);

    if (sub === "list") {
      const auth = await requireMusicPermission(ctx, "can_play");
      if (!auth) return;
      const stations = liveStations();
      if (stations.length === 0) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.info} There are no radio stations on air yet.`, ephemeral));
        return;
      }
      const counts = listenerCounts();
      const tuned = currentStationId(getConnectedPlayer(guildId));
      const lines = stations.map((s) => {
        const live = nowLine(s.id) ?? `${RADIO} **${s.name}**`;
        const listening = counts.get(s.id) ?? 0;
        const extra = [s.id === tuned ? "on air here" : null, listening ? `${listening} server${listening === 1 ? "" : "s"} listening` : null]
          .filter(Boolean)
          .join(" · ");
        return extra ? `${live}\n-# ${extra}` : live;
      });
      lines.push(`-# Tune in with /radio play, or from the [web player](${getGuildMusicPlayerUrl(guildId)}).`);
      await interaction.reply(lineReply(lines.join("\n"), ephemeral));
      return;
    }

    if (sub === "nowplaying") {
      const auth = await requireMusicPermission(ctx, "can_play");
      if (!auth) return;
      const stationId = currentStationId(getConnectedPlayer(guildId));
      const line = stationId ? nowLine(stationId) : null;
      await interaction.reply(lineReply(line ?? `${MUSIC_EMOJI.info} No radio station is on air here. Try /radio list.`, ephemeral));
      return;
    }

    if (sub === "leave") {
      const auth = await requireMusicPermission(ctx, "can_skip");
      if (!auth) return;
      const player = await requireActivePlayer(ctx, guildId);
      if (!player) return;
      const stationId = currentStationId(player);
      if (!stationId) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.info} No radio station is on air here.`, ephemeral));
        return;
      }
      const member = auth.member as GuildMember;
      if (!memberSharesVoiceChannel(member, player)) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} You need to be in the voice channel to do that.`, ephemeral));
        return;
      }
      const name = getLive(stationId)?.station.name ?? "the station";
      const requesterId = (player.queue.current?.requester as { id?: string } | undefined)?.id;
      const bypass = canBypassVoteSkip(member, auth.config, auth.config.can_force_skip) || requesterId === member.id;
      if (!bypass) {
        const channel = member.voice.channel as VoiceBasedChannel | null;
        const nonBotCount = channel ? channel.members.filter((m) => !m.user.bot).size : 1;
        const need = requiredVotes(nonBotCount, auth.config.vote_skip_threshold_percent);
        const vote = registerVote(guildId, `radio:${stationId}`, member.id, need, auth.config.vote_skip_timeout_seconds * 1000);
        if (vote.status !== "skipped") {
          const body = vote.status === "already_voted" ? `You've already voted (${vote.have}/${vote.need}).` : `Vote to leave the radio: **${vote.have}/${vote.need}**.`;
          await interaction.reply(lineReply(`${MUSIC_EMOJI.vote} ${body}`, ephemeral));
          return;
        }
      }
      clearVotes(guildId);
      await leaveRadio(player);
      void saveSessionNow(player).catch(() => {});
      await interaction.reply(lineReply(`${MUSIC_EMOJI.leave} Left **${name}**.`, ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_skip", "Music - Left Radio", [
        `By: <@${interaction.user.id}>`,
        `Station: **${name}**`,
      ], { actorId: interaction.user.id });
      return;
    }

    // /radio play
    const auth = await requireMusicPermission(ctx, "can_play");
    if (!auth) return;
    if (auth.config.radios_enabled === false) {
      await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Radio stations are turned off on this server.`, ephemeral));
      return;
    }
    if (!isLavalinkConfigured()) {
      await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Music isn't configured on this bot yet.`, ephemeral));
      return;
    }
    const stationId = interaction.options.getString("station", true);
    const live = getLive(stationId);
    if (!live || live.station.visibility !== "live") {
      await interaction.reply(lineReply(`${MUSIC_EMOJI.error} That station isn't on air. Pick one from the list.`, ephemeral));
      return;
    }
    const member = auth.member as GuildMember;
    const voiceChannelId = member.voice.channelId;
    if (!voiceChannelId) {
      await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Join a voice channel first.`, ephemeral));
      return;
    }
    const channelBlock = musicChannelBlock(auth.config, voiceChannelId, interaction.channelId);
    if (channelBlock) {
      await interaction.reply(lineReply(`${MUSIC_EMOJI.error} ${channelBlock}`, ephemeral));
      return;
    }

    await interaction.deferReply(deferReplyOptions(ephemeral));
    const claim = await getOrConnectPlayer(guildId, voiceChannelId, interaction.channelId, { member, config: auth.config });
    if (!claim.ok) {
      const body =
        claim.reason === "blocked_by_other"
          ? blockedByMessage("music", claim.ownedBy)
          : claim.reason === "in_use_elsewhere"
            ? `People are listening in <#${claim.channelId}>. Join them, or ask a DJ to move the music.`
            : "Couldn't connect to that voice channel.";
      await interaction.editReply(lineEdit(`${MUSIC_EMOJI.error} ${body}`));
      return;
    }
    try {
      const result = await tuneIn(claim.player, stationId, interaction.user.id);
      if (!result.ok) {
        await interaction.editReply(lineEdit(`${MUSIC_EMOJI.error} ${result.error}`));
        return;
      }
      void saveSessionNow(claim.player).catch(() => {});
      const line = result.started
        ? `${nowLine(stationId) ?? `${RADIO} **${live.station.name}**`}\n-# Tuned in. Everyone listening hears the same live song. /radio leave to switch off.`
        : `${RADIO} **${live.station.name}** is queued. It goes on air after the current queue.`;
      await interaction.editReply(lineEdit(line));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_play", result.started ? "Music - Radio Tuned In" : "Music - Radio Queued", [
        `By: <@${interaction.user.id}>`,
        "Source: Discord (/radio play)",
        `Station: **${live.station.name}**`,
      ], { actorId: interaction.user.id, channelId: voiceChannelId });
    } catch (error) {
      log.error(`Radio tune-in failed for station ${stationId} in guild ${guildId}:`, error);
      await interaction.editReply(lineEdit(`${MUSIC_EMOJI.error} Couldn't tune into ${live.station.name} right now. Try again in a moment.`));
    }
  },
};
