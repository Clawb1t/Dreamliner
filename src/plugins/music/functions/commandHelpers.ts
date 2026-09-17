import type { GuildMember } from "discord.js";
import type { Player } from "lavalink-client";
import type { InteractionReplyOptions, InteractionEditReplyOptions } from "discord.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { embedReply, embedEdit } from "../../../core/responses.js";
import { baseEmbed } from "../../../core/embeds.js";
import type { SlashCommandContext } from "../../../core/types.js";
import { zMusicConfig, type MusicConfig } from "../../../config/schemas/music.js";
import { getConnectedPlayer } from "./player.js";
import { canControlPlayback, isDj } from "./permissions.js";
import { MUSIC_EMOJI } from "./emojis.js";

export type MusicAuth = { member: GuildMember; config: MusicConfig };

/** Every music response is one line of text, but still wrapped in the bot's normal Components V2
 *  container (matching the rest of the bot) rather than a raw plain-content message. */
export function lineReply(line: string, ephemeral: boolean): InteractionReplyOptions {
  return embedReply(baseEmbed().setDescription(line), ephemeral);
}

export function lineEdit(line: string): InteractionEditReplyOptions {
  return embedEdit(baseEmbed().setDescription(line));
}

/** Standard permission gate for every music command — resolves the caller's permission flag and
 *  hands back a typed MusicConfig instead of the raw Record<string, unknown>. */
export async function requireMusicPermission(ctx: SlashCommandContext, permission: string): Promise<MusicAuth | null> {
  const auth = await requirePluginPermission(ctx, "music", permission);
  if (!auth) return null;
  return { member: auth.member, config: zMusicConfig.parse(auth.pluginConfig) };
}

/** For commands that act on the current player (skip/pause/stop/etc.) — replies and returns null
 *  if nothing is playing in this guild. */
export async function requireActivePlayer(ctx: SlashCommandContext, guildId: string): Promise<Player | null> {
  const player = getConnectedPlayer(guildId);
  if (!player) {
    await ctx.interaction.reply(lineReply(`${MUSIC_EMOJI.info} Nothing is playing right now.`, ctx.ephemeral));
    return null;
  }
  return player;
}

/** Enforces that the caller is actually in the bot's voice channel, so playback control can't be
 *  hijacked from elsewhere in the server. */
export function memberSharesVoiceChannel(member: GuildMember, player: Player): boolean {
  return member.voice.channelId === player.voiceChannelId;
}

/** DJ-mode-aware gate for direct playback control (pause/resume/stop/volume/seek/filter/queue
 *  management/loop) — in DJ mode only DJs may act; otherwise the caller's own can_* flag decides.
 *  Replies with a permission-denied one-liner and returns false when blocked. */
export async function requirePlaybackControl(
  ctx: SlashCommandContext,
  member: GuildMember,
  config: MusicConfig,
  hasFlag: boolean,
): Promise<boolean> {
  if (canControlPlayback(member, config, hasFlag)) return true;
  const body = config.dj_mode
    ? `${MUSIC_EMOJI.error} Only DJs can do that while DJ mode is on.`
    : `${MUSIC_EMOJI.error} You don't have permission to do that.`;
  await ctx.interaction.reply(lineReply(body, ctx.ephemeral));
  return false;
}

export { isDj };
