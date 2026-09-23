import type { Guild, GuildMember } from "discord.js";
import type { ActivityRewardsConfig } from "../../../config/schemas/activityRewards.js";
import { managedRoleIds } from "./config.js";
import { forgetAwarded, processMember } from "./rewards.js";
import { getProgress, resetMember } from "./store.js";

/**
 * Silently re-applies milestone roles for every member with progress, with no announcements, so
 * backfilling a server's history (dashboard import) doesn't flood a channel. Returns how many
 * members were checked and how many newly earned at least one milestone.
 */
export async function syncGuildMembers(
  guild: Guild,
  config: ActivityRewardsConfig,
): Promise<{ checked: number; rewarded: number }> {
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return { checked: 0, rewarded: 0 };

  let checked = 0;
  let rewarded = 0;
  for (const member of members.values()) {
    if (member.user.bot) continue;
    const progress = getProgress(guild.id, member.id);
    if (progress.messages === 0 && progress.voiceSeconds === 0) continue;
    checked++;
    const result = await processMember(member, config, progress, { announce: false, resync: true }).catch(() => null);
    if (result && result.newlyReached.length > 0) rewarded++;
  }
  return { checked, rewarded };
}

/** Wipes a member's progress and history, and takes back every milestone role they hold. */
export async function resetMemberRewards(member: GuildMember, config: ActivityRewardsConfig): Promise<string[]> {
  resetMember(member.guild.id, member.id);
  forgetAwarded(member.guild.id, member.id);
  const held = [...managedRoleIds(config)].filter((id) => member.roles.cache.has(id));
  if (held.length > 0) await member.roles.remove(held, "Activity Rewards progress reset").catch(() => null);
  return held;
}
