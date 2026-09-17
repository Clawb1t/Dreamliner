import { SlashCommandBuilder, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { deferReplyOptions } from "../../../core/responses.js";
import { requireMusicPermission, lineReply, lineEdit } from "../functions/commandHelpers.js";
import { getOrConnectPlayer, getConnectedPlayer } from "../functions/player.js";
import type { Track } from "lavalink-client";
import { isLavalinkConfigured } from "../functions/manager.js";
import { blockedByMessage } from "../../../core/voiceSessionRegistry.js";
import {
  listPlaylists,
  getPlaylist,
  getPlaylistTracks,
  savePlaylist,
  deletePlaylist,
  renamePlaylist,
} from "../functions/playlistStore.js";
import { formatDuration } from "../functions/formatting.js";
import { MUSIC_EMOJI } from "../functions/emojis.js";
import { saveSessionNow } from "../functions/sessionPersistence.js";
import { logMusic } from "../functions/musicLog.js";

export const playlistCommand: SlashCommandDefinition = {
  plugin: "music",
  data: new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Save and load your own playlists")
    .addSubcommand((sub) => sub.setName("save").setDescription("Save the current queue as a playlist").addStringOption((o) => o.setName("name").setDescription("Playlist name").setRequired(true)))
    .addSubcommand((sub) => sub.setName("load").setDescription("Queue up a saved playlist").addStringOption((o) => o.setName("name").setDescription("Playlist name").setRequired(true).setAutocomplete(true)))
    .addSubcommand((sub) => sub.setName("list").setDescription("List your saved playlists"))
    .addSubcommand((sub) => sub.setName("show").setDescription("Show the tracks in a playlist").addStringOption((o) => o.setName("name").setDescription("Playlist name").setRequired(true).setAutocomplete(true)))
    .addSubcommand((sub) =>
      sub
        .setName("rename")
        .setDescription("Rename a playlist")
        .addStringOption((o) => o.setName("name").setDescription("Current name").setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName("new_name").setDescription("New name").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("delete").setDescription("Delete a playlist").addStringOption((o) => o.setName("name").setDescription("Playlist name").setRequired(true).setAutocomplete(true))),
  execute: async (ctx) => {
    const { interaction, ephemeral } = ctx;
    const sub = interaction.options.getSubcommand(true);
    const guildId = interaction.guildId!;
    const ownerId = interaction.user.id;

    const auth = await requireMusicPermission(ctx, "can_manage_playlists");
    if (!auth) return;

    if (sub === "list") {
      const playlists = await listPlaylists(ownerId);
      const body = playlists.length ? playlists.map((p) => `\`${p.name}\``).join(", ") : "You have no saved playlists yet.";
      await interaction.reply(lineReply(`${MUSIC_EMOJI.playlist} Your playlists: ${body}`, ephemeral));
      return;
    }

    if (sub === "show") {
      const name = interaction.options.getString("name", true);
      const playlist = await getPlaylist(ownerId, name);
      if (!playlist) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} No playlist named **${name}**.`, ephemeral));
        return;
      }
      const tracks = await getPlaylistTracks(playlist.id);
      const total = tracks.reduce((sum, t) => sum + t.durationMs, 0);
      const lines = tracks.slice(0, 15).map((t, i) => `\`${i + 1}.\` ${t.uri ? `[${t.title}](${t.uri})` : t.title}`);
      if (tracks.length > 15) lines.push(`-# +${tracks.length - 15} more`);
      lines.push(`-# ${tracks.length} track${tracks.length === 1 ? "" : "s"} · ${formatDuration(total)}`);
      await interaction.reply(lineReply(`${MUSIC_EMOJI.playlist} **${playlist.name}**\n${lines.join("\n")}`, ephemeral));
      return;
    }

    if (sub === "rename") {
      const name = interaction.options.getString("name", true);
      const newName = interaction.options.getString("new_name", true);
      const result = await renamePlaylist(ownerId, name, newName);
      if (!result.ok) {
        const body = result.reason === "not_found" ? `No playlist named **${name}**.` : `You already have a playlist named **${newName}**.`;
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} ${body}`, ephemeral));
        return;
      }
      await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Renamed **${name}** to **${newName}**.`, ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_playlist", "Music - Playlist Renamed", [
        `By: <@${ownerId}>`,
        `Renamed **${name}** to **${newName}**`,
      ], { actorId: ownerId, emojiCategory: "edit" });
      return;
    }

    if (sub === "delete") {
      const name = interaction.options.getString("name", true);
      const result = await deletePlaylist(ownerId, name);
      if (!result.ok) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} No playlist named **${name}**.`, ephemeral));
        return;
      }
      await interaction.reply(lineReply(`${MUSIC_EMOJI.success} Deleted playlist **${name}**.`, ephemeral));
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_playlist", "Music - Playlist Deleted", [
        `By: <@${ownerId}>`,
        `Deleted playlist **${name}**`,
      ], { actorId: ownerId, emojiCategory: "delete" });
      return;
    }

    if (sub === "save") {
      const name = interaction.options.getString("name", true);
      const player = getConnectedPlayer(guildId);
      const tracks = [
        ...(player?.queue.current ? [player.queue.current] : []),
        ...(player?.queue.tracks.filter((t): t is Track => !("resolve" in t)) ?? []),
      ];
      if (tracks.length === 0) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Nothing is queued right now to save.`, ephemeral));
        return;
      }
      const result = await savePlaylist(ownerId, name, tracks);
      if (!result.ok) {
        await interaction.reply(lineReply(`${MUSIC_EMOJI.error} You already have a playlist named **${name}**.`, ephemeral));
        return;
      }
      await interaction.reply(
        lineReply(`${MUSIC_EMOJI.success} Saved **${tracks.length}** track${tracks.length === 1 ? "" : "s"} as **${result.playlist.name}**.`, ephemeral),
      );
      void logMusic(interaction.client, ctx.guildConfig, guildId, "music_playlist", "Music - Playlist Saved", [
        `By: <@${ownerId}>`,
        `Saved **${tracks.length}** track${tracks.length === 1 ? "" : "s"} as **${result.playlist.name}**`,
      ], { actorId: ownerId, emojiCategory: "create" });
      return;
    }

    // sub === "load"
    if (!isLavalinkConfigured()) {
      await interaction.reply(lineReply(`${MUSIC_EMOJI.error} Music isn't configured on this bot yet.`, ephemeral));
      return;
    }
    const name = interaction.options.getString("name", true);
    const playlist = await getPlaylist(ownerId, name);
    if (!playlist) {
      await interaction.reply(lineReply(`${MUSIC_EMOJI.error} No playlist named **${name}**.`, ephemeral));
      return;
    }
    const rows = await getPlaylistTracks(playlist.id);
    if (rows.length === 0) {
      await interaction.reply(lineReply(`${MUSIC_EMOJI.error} That playlist is empty.`, ephemeral));
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

    let queued = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.encoded) {
        await player.queue.add({
          encoded: row.encoded,
          info: {
            identifier: row.encoded,
            title: row.title,
            author: row.artist ?? "",
            duration: row.durationMs,
            artworkUrl: row.artworkUrl,
            uri: row.uri ?? "",
            sourceName: "soundcloud",
            isSeekable: true,
            isStream: false,
            isrc: null,
          },
          pluginInfo: {},
          requester: interaction.user,
        });
        queued++;
        continue;
      }
      const result = await player.search({ query: `${row.title} ${row.artist ?? ""}`.trim() }, interaction.user).catch(() => null);
      const track = result?.tracks[0];
      if (!track) {
        failed++;
        continue;
      }
      track.requester = interaction.user;
      await player.queue.add(track);
      queued++;
    }

    if (!player.playing && !player.queue.current) await player.play();
    void saveSessionNow(player).catch(() => {});

    const failedNote = failed > 0 ? ` (${failed} couldn't be resolved)` : "";
    await interaction.editReply(
      lineEdit(`${MUSIC_EMOJI.playlist} Queued **${queued}** track${queued === 1 ? "" : "s"} from **${playlist.name}**${failedNote}.`),
    );
    void logMusic(interaction.client, ctx.guildConfig, guildId, "music_play", "Music - Playlist Loaded", [
      `By: <@${ownerId}>`,
      "Source: Discord (/playlist load)",
      `Queued **${queued}** track${queued === 1 ? "" : "s"} from **${playlist.name}**${failedNote}`,
    ], { actorId: ownerId, channelId: voiceChannelId });
  },
};
