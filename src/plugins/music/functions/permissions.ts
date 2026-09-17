import type { GuildMember } from "discord.js";
import type { MusicConfig } from "../../../config/schemas/music.js";

export function isDj(member: GuildMember, config: MusicConfig): boolean {
  if (config.dj_roles.length === 0) return false;
  return member.roles.cache.some((role) => config.dj_roles.includes(role.id));
}

/** DJs, and anyone with can_force_skip, bypass vote-skip and DJ-mode playback locks entirely. */
export function canBypassVoteSkip(member: GuildMember, config: MusicConfig, canForceSkip: boolean): boolean {
  return canForceSkip || isDj(member, config);
}

/** In DJ mode, only DJs may control playback directly (non-DJs fall back to vote-skip for skip,
 *  and are blocked entirely from pause/stop/queue-management/volume/filters/loop). */
export function canControlPlayback(member: GuildMember, config: MusicConfig, hasFlag: boolean): boolean {
  if (config.dj_mode) return isDj(member, config);
  return hasFlag;
}
