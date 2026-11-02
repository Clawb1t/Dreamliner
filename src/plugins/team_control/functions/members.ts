import type { Guild, GuildMember, PartialGuildMember } from "discord.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { getLogger } from "../../../core/logger.js";
import { loadActiveTeamControl } from "./config.js";
import { applyOneGate, isTeamOneActive } from "./oneGate.js";
import { onJoinTeam } from "./onboarding.js";
import { memberRank } from "./ranks.js";
import { scheduleRosterUpdate } from "./roster.js";
import { endShiftRecord } from "./shifts.js";
import { getActiveShift, getTeamMember, listCurrentTeam, upsertTeamMember } from "./store.js";

const log = getLogger("team_control");

/** Full member fetches (the 30-minute sweep) only run on servers up to this size; bigger ones re-check known staff. */
const FULL_FETCH_MAX_MEMBERS = 5000;

/** The guild's effective (One-gated) config when Team Control is on and has ranks, else null. */
export async function loadTeamRuntime(guildId: string) {
  const active = await loadActiveTeamControl(guildId);
  if (!active) return null;
  const one = await isTeamOneActive(guildId);
  // Gated once per parsed config object and One state (staff messages read this constantly).
  let gated = gatedConfigs.get(active.config);
  if (!gated || gated.one !== one) {
    gated = { one, config: applyOneGate(active.config, one) };
    gatedConfigs.set(active.config, gated);
  }
  return { ...active, one, config: gated.config };
}

const gatedConfigs = new WeakMap<TeamControlConfig, { one: boolean; config: TeamControlConfig }>();

/**
 * Brings one member's team row in line with their roles. Holding a rank role puts them on the
 * team (running onboarding the first time, or when they come back); losing every rank role marks
 * them as having left, unless a suspension took the roles away on purpose.
 */
export async function syncMember(member: GuildMember, config: TeamControlConfig, options: { quiet?: boolean } = {}): Promise<"joined" | "left" | "same"> {
  if (member.user.bot) return "same";
  const rank = memberRank(member, config.ranks);
  const row = getTeamMember(member.guild.id, member.id);
  if (rank) {
    const rejoining = !row || row.leftTeamAt !== null || row.status === "terminated";
    if (rejoining) {
      upsertTeamMember(member.guild.id, member.id, {
        joinedAt: new Date(),
        leftTeamAt: null,
        status: "active",
        rankId: rank.id,
        suspendedUntil: null,
        suspendedRoleIds: "[]",
        trialEndsAt: null,
        trialReviewedAt: null,
      });
      if (!options.quiet) await onJoinTeam(member, config, rank).catch((error) => log.warn(`Onboarding failed for ${member.id}: ${error instanceof Error ? error.message : error}`));
      scheduleRosterUpdate(member.guild.id);
      return "joined";
    }
    if (row.rankId !== rank.id) {
      upsertTeamMember(member.guild.id, member.id, { rankId: rank.id });
      scheduleRosterUpdate(member.guild.id);
    }
    return "same";
  }
  if (row && row.status === "active" && row.leftTeamAt === null) {
    upsertTeamMember(member.guild.id, member.id, { leftTeamAt: new Date() });
    const shift = getActiveShift(member.guild.id, member.id);
    if (shift) await endShiftRecord(member.guild, config, shift, "admin", { member, note: "Left the team" });
    scheduleRosterUpdate(member.guild.id);
    return "left";
  }
  return "same";
}

/** A member left the server: they're off the team (a suspension stays on record). */
export async function handleTeamMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
  const runtime = await loadTeamRuntime(member.guild.id);
  if (!runtime) return;
  const row = getTeamMember(member.guild.id, member.id);
  if (!row || row.leftTeamAt) return;
  if (row.status === "active") upsertTeamMember(member.guild.id, member.id, { leftTeamAt: new Date() });
  const shift = getActiveShift(member.guild.id, member.id);
  if (shift) await endShiftRecord(member.guild, runtime.config, shift, "admin", { member: null, note: "Left the server" });
  scheduleRosterUpdate(member.guild.id);
}

/**
 * Syncs the whole team with Discord. `full` loads every member (needed to discover rank holders
 * the bot never saw change); otherwise only known staff and cached members are re-checked.
 * Returns how many members are on the team afterwards.
 */
export async function syncGuildTeam(guild: Guild, config: TeamControlConfig, full: boolean): Promise<number> {
  if (config.ranks.every((rank) => !rank.role_id)) return 0;
  const known = listCurrentTeam(guild.id).map((row) => row.userId);
  const seen = new Set<string>();
  const check = async (member: GuildMember) => {
    if (seen.has(member.id)) return;
    seen.add(member.id);
    // A first sync onboards nobody: everyone already on the team isn't new staff.
    await syncMember(member, config, { quiet: known.length === 0 });
  };
  if (full) {
    const members = await guild.members.fetch().catch(() => null);
    if (members) for (const member of members.values()) await check(member);
  } else {
    for (let i = 0; i < known.length; i += 100) {
      const batch = await guild.members.fetch({ user: known.slice(i, i + 100) }).catch(() => null);
      if (batch) for (const member of batch.values()) await check(member);
    }
    for (const member of guild.members.cache.values()) await check(member);
  }
  // Known staff who weren't found have left the server.
  if (full || known.length > 0) {
    for (const userId of known) {
      if (seen.has(userId)) continue;
      const exists = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (exists) await check(exists);
      else {
        const row = getTeamMember(guild.id, userId);
        if (row?.status === "active" && !row.leftTeamAt) upsertTeamMember(guild.id, userId, { leftTeamAt: new Date() });
      }
    }
  }
  return listCurrentTeam(guild.id).length;
}

export function shouldFullFetch(guild: Guild): boolean {
  return guild.memberCount <= FULL_FETCH_MAX_MEMBERS;
}
