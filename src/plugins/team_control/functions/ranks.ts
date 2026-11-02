import type { Guild, GuildMember, Role } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { TeamControlConfig, TeamRank } from "../../../config/schemas/teamControl.js";
import { hasAdminBypass } from "../../../core/permissionRoles.js";
import { autoGrantableRoleIds, canManageRole } from "../../../core/roles.js";
import { rankIndexForRoles, type AuthorityActor } from "./authority.js";

/** Who is acting: a member (from a command or the dashboard), or a dashboard superuser who isn't in the server. */
export type TeamActor = AuthorityActor & { member: GuildMember | null };

export function memberRankIndex(member: GuildMember | null | undefined, ranks: TeamRank[]): number {
  if (!member) return -1;
  return rankIndexForRoles(ranks, member.roles.cache.keys());
}

export function memberRank(member: GuildMember | null | undefined, ranks: TeamRank[]): TeamRank | null {
  return ranks[memberRankIndex(member, ranks)] ?? null;
}

export function isOnTeam(member: GuildMember | null | undefined, ranks: TeamRank[]): boolean {
  return memberRankIndex(member, ranks) >= 0;
}

/** Owner, Administrator or Manage Server (unless the server turned admin bypass off; the owner always bypasses). */
export function bypassesAuthority(member: GuildMember, guildConfig: GuildConfig): boolean {
  return member.id === member.guild.ownerId || hasAdminBypass(member, guildConfig);
}

/** `member` null = a dashboard superuser who isn't in the server: treated like Manage Server. */
export function resolveActor(member: GuildMember | null, userId: string, guildConfig: GuildConfig, ranks: TeamRank[]): TeamActor {
  return {
    member,
    userId,
    bypass: member ? bypassesAuthority(member, guildConfig) : true,
    rankIndex: memberRankIndex(member, ranks),
  };
}

export function rankRoleIds(ranks: TeamRank[]): string[] {
  return ranks.map((rank) => rank.role_id).filter((id): id is string => Boolean(id));
}

/** Rank roles the member holds right now. */
export function heldRankRoleIds(member: GuildMember, ranks: TeamRank[]): string[] {
  return rankRoleIds(ranks).filter((id) => member.roles.cache.has(id));
}

/** Why Dreamliner can't give or take a role, or null when it can. */
export function botRoleProblem(guild: Guild, roleId: string): string | null {
  const role = guild.roles.cache.get(roleId);
  if (!role) return "A role set up for Team Control no longer exists. Update it on the dashboard.";
  const me = guild.members.me;
  if (!me?.permissions.has("ManageRoles")) return "I need the **Manage Roles** permission to change staff roles.";
  if (role.managed) return `The **${role.name}** role is managed by an integration, so I can't give or take it.`;
  if (role.position >= me.roles.highest.position) {
    return `I can't manage the **${role.name}** role. Move Dreamliner's role above it in Server Settings → Roles.`;
  }
  return null;
}

/**
 * Why `actor` can't give or take a rank role from `target`, or null. Bypassing actors still need
 * Discord's own hierarchy (role below their top role, and permissions they have themselves), so
 * a Dreamliner action never hands out more power than the person taking it.
 */
export function actorRoleProblem(actor: TeamActor, role: Role, target: GuildMember | null): string | null {
  if (!actor.member) return null;
  if (actor.member.id === actor.member.guild.ownerId) return null;
  if (!canManageRole(actor.member, role, target && target.id !== actor.member.id ? target : null)) {
    return `You can't give or take the **${role.name}** role. It's at or above your highest role, has permissions you don't have, or they're ranked at or above you on Discord.`;
  }
  return null;
}

/** Every role problem for a set of rank roles, first one wins. */
export function rankRolesProblem(guild: Guild, actor: TeamActor | null, roleIds: string[], target: GuildMember | null): string | null {
  for (const roleId of roleIds) {
    const botProblem = botRoleProblem(guild, roleId);
    if (botProblem) return botProblem;
    const role = guild.roles.cache.get(roleId)!;
    if (actor) {
      const problem = actorRoleProblem(actor, role, target);
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * Status roles (duty, LOA, RA, suspended) are handed out automatically, so they go through the
 * same filter as every auto-granted role: below the bot and without staff permissions.
 */
export function usableStatusRole(guild: Guild, roleId: string | null): string | null {
  if (!roleId) return null;
  return autoGrantableRoleIds(guild, [roleId])[0] ?? null;
}

/** Dashboard warnings: configured roles Dreamliner can't use, missing channels, unmeasurable quotas. */
export function configWarnings(guild: Guild, config: TeamControlConfig): string[] {
  const warnings: string[] = [];
  const me = guild.members.me;
  if (!me?.permissions.has("ManageRoles")) warnings.push("Dreamliner needs the Manage Roles permission to change staff roles.");
  for (const rank of config.ranks) {
    if (!rank.role_id) {
      warnings.push(`The ${rank.name} rank has no role linked.`);
      continue;
    }
    const role = guild.roles.cache.get(rank.role_id);
    if (!role) warnings.push(`The ${rank.name} rank's role no longer exists.`);
    else if (me && role.position >= me.roles.highest.position) warnings.push(`The ${rank.name} role is above Dreamliner's highest role, so promotions to it will fail.`);
  }
  const statusRoles: Array<[string, string | null]> = [
    ["Duty role", config.shifts.duty_role_id],
    ["LOA role", config.leave.loa_role_id],
    ["RA role", config.leave.ra_role_id],
    ["Suspended role", config.actions.suspended_role_id],
  ];
  for (const [label, roleId] of statusRoles) {
    if (!roleId) continue;
    const role = guild.roles.cache.get(roleId);
    if (!role) warnings.push(`${label} no longer exists.`);
    else if (!usableStatusRole(guild, roleId)) {
      warnings.push(
        me && role.position >= me.roles.highest.position
          ? `${label} is above Dreamliner's highest role.`
          : `${label} has staff permissions, so Dreamliner won't hand it out automatically.`,
      );
    }
  }
  const hasMessageQuota = config.ranks.some((rank) => rank.quota.messages > 0);
  if (hasMessageQuota && config.activity.staff_channel_ids.length === 0) {
    warnings.push("Some ranks have a messages quota, but no staff channels are set, so messages aren't counted.");
  }
  if (config.roster.enabled && !config.roster.channel_id) warnings.push("The roster is on but has no channel.");
  if (config.onboarding.enabled && config.onboarding.trial_days > 0 && !config.onboarding.review_channel_id && !config.log_channel_id) {
    warnings.push("Trials are on but there's no review or log channel to post trial reviews in.");
  }
  return warnings;
}
