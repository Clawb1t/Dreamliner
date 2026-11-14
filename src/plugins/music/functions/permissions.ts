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

/** In DJ mode, only DJs - and anyone with can_force_skip, which the resolved config already sets
 *  for owner/Administrator/Manage Server under admin_bypass - may control playback directly
 *  (everyone else falls back to vote-skip for skip, and is blocked entirely from
 *  pause/stop/queue-management/volume/filters/loop). `config` must be the member-resolved one. */
export function canControlPlayback(member: GuildMember, config: MusicConfig, hasFlag: boolean): boolean {
  if (config.dj_mode) return canBypassVoteSkip(member, config, config.can_force_skip === true);
  return hasFlag;
}
