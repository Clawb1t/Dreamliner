import { SlashCommandBuilder, type GuildMember } from "discord.js";
import type { Track } from "lavalink-client";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { deferReplyOptions, embedEdit, containersEdit } from "../../../core/responses.js";
import { blockedByMessage } from "../../../core/voiceSessionRegistry.js";
import { getLogger } from "../../../core/logger.js";
import { getOrConnectPlayer } from "../functions/player.js";
import { isLavalinkConfigured } from "../functions/manager.js";
import { requireMusicPermission, lineReply, lineEdit } from "../functions/commandHelpers.js";
import { noResultsLine, searchFailedLine, buildTrackContainer, buildWebPlayerAnnounceContainer } from "../functions/formatting.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { startRetryPlan } from "../functions/retryQueue.js";
import { saveSessionNow } from "../functions/sessionPersistence.js";
import { hasAnnouncedWebPlayer, markWebPlayerAnnounced } from "../functions/webPlayerAnnounce.js";
import { logMusic } from "../functions/musicLog.js";
import { formatDuration } from "../functions/formatting.js";

const log = getLogger("music");

export const playCommand: SlashCommandDefinition = {
  plugin: "music",
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play or queue a track")
    .addStringOption((o) => o.setName("query").setDescription("A search term or a direct link").setRequired(true)),
  execute: async (ctx) => {
    const { interaction, ephemeral } = ctx;
    const guildId = interaction.guildId!;

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

    await interaction.deferReply(deferReplyOptions(ephemeral));

    const claim = await getOrConnectPlayer(guildId, voiceChannelId, interaction.channelId);
    if (!claim.ok) {
      const body = claim.reason === "blocked_by_other" ? blockedByMessage("music", claim.ownedBy) : "Couldn't connect to that voice channel.";
      await interaction.editReply(lineEdit(`${MUSIC_EMOJI.error} ${body}`));
      return;
    }
    const { player } = claim;

    const query = interaction.options.getString("query", true);
    let result: Awaited<ReturnType<typeof player.search>> | null = null;
    let searchFailed = false;
    // One retry: a node timeout is usually a transient blip (network hiccup, a slow upstream
    // source lookup) rather than a real "nothing found" - worth one more shot before telling the
    // user to search something else entirely.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await player.search({ query }, interaction.user);
        searchFailed = false;
        break;
      } catch (err) {
        searchFailed = true;
        log.error(`Music search failed for query=${JSON.stringify(query)} in guild ${guildId} (attempt ${attempt + 1}/2):`, err);
      }
    }

    if (searchFailed) {
      await interaction.editReply(lineEdit(searchFailedLine(query)));
      return;
    }
    if (!result || result.loadType === "error" || result.loadType === "empty" || result.tracks.length === 0) {
      await interaction.editReply(lineEdit(noResultsLine(query)));
      return;
    }

    const first = result.tracks[0]!;
    if ("resolve" in first) await first.resolve(player);
    const track = first as Track;
    track.requester = interaction.user;

    const wasPlaying = player.playing || Boolean(player.queue.current);
    const size = await player.queue.add(track);
    void saveSessionNow(player).catch((error: unknown) => log.error(`Failed to save music session for guild ${guildId}:`, error));

    if (!wasPlaying) {
      // Neither YouTube (intermittent anti-bot wall, even with the PO-token bypass) nor
      // SoundCloud (occasional per-track 404s) is 100% reliable - stash the other results from
      // this search, plus the original query for a different-source fallback, so a failure can
      // retry automatically instead of the bot just going quiet (see events.ts).
      const alternates = result.tracks.slice(1).filter((t): t is Track => !("resolve" in t));
      startRetryPlan(guildId, query, interaction.user.id, alternates);

      const showWebPlayer = !hasAnnouncedWebPlayer(guildId);
      if (showWebPlayer) markWebPlayerAnnounced(guildId);
      await player.play();

      const trackEntry = buildTrackContainer(track, { kind: "now_playing" });
      if (showWebPlayer) {
        await interaction.editReply(containersEdit([trackEntry, buildWebPlayerAnnounceContainer(guildId)]));
      } else {
        await interaction.editReply(embedEdit(trackEntry.container, trackEntry.row ? [trackEntry.row] : undefined));
      }
      void logMusic(
        interaction.client,
        ctx.guildConfig,
        guildId,
        "music_play",
        "Music - Track Started",
        [`By: <@${interaction.user.id}>`, "Source: Discord (/play)", `Track: **${track.info.title}**${track.info.author ? ` - ${track.info.author}` : ""} (\`${formatDuration(track.info.duration)}\`)`, "Position: now playing"],
        { actorId: interaction.user.id, channelId: voiceChannelId, avatarUrl: track.info.artworkUrl },
      );
      return;
    }

    const { container, row } = buildTrackContainer(track, {
      kind: "queued",
      positionInQueue: Number(size) || 0,
    });
    await interaction.editReply(embedEdit(container, row ? [row] : undefined));
    void logMusic(
      interaction.client,
      ctx.guildConfig,
      guildId,
      "music_play",
      "Music - Track Queued",
      [`By: <@${interaction.user.id}>`, "Source: Discord (/play)", `Track: **${track.info.title}**${track.info.author ? ` - ${track.info.author}` : ""} (\`${formatDuration(track.info.duration)}\`)`, `Position: #${Number(size) || 0} in queue`],
      { actorId: interaction.user.id, channelId: voiceChannelId, avatarUrl: track.info.artworkUrl },
    );
  },
};
