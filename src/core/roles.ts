import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";

/**
 * Permissions that make a role a staff role. Roles the bot hands out on its own (self-serve
 * panels and buttons, autoroles, rewards, rules) must never carry these: the people who set those
 * features up only need Manage Server on the dashboard, so otherwise they could make the bot give
 * them (or anyone) Administrator without ever having Manage Roles.
 */
const STAFF_PERMISSIONS =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.ModerateMembers;

/** True when the role grants any staff-level permission (see STAFF_PERMISSIONS). */
export function isStaffRole(role: Role): boolean {
  return (role.permissions.bitfield & STAFF_PERMISSIONS) !== 0n;
}

/** The ids the bot may hand out automatically: real, unmanaged roles in this guild, below the bot,
 *  and not staff roles. */
export function autoGrantableRoleIds(guild: Guild, roleIds: Iterable<string>): string[] {
  const me = guild.members.me;
  return [...roleIds].filter((id) => {
    const role = guild.roles.cache.get(id);
    return Boolean(role && id !== guild.id && !role.managed && !isStaffRole(role) && me && role.position < me.roles.highest.position);
  });
}

export type RoleActionResult = { ok: true } | { ok: false; reason: string };

/**
 * Whether `actor` may give or take `role` (from `target`, when given) through Dreamliner. Besides
 * Discord's own rule (the role sits below the actor and the bot), the actor must already have every
 * permission the role grants, so a Dreamliner permission can never be turned into more Discord
 * power than they have, and they can't change the roles of someone ranked at or above them.
 */
export function canManageRole(actor: GuildMember, role: Role, target?: GuildMember | null): boolean {
  if (!actor.guild.members.me?.permissions.has("ManageRoles")) return false;
  if (role.managed) return false;
  if (role.id === actor.guild.id) return false;
  if (role.position >= actor.guild.members.me!.roles.highest.position) return false;
  if (actor.id === actor.guild.ownerId) return true;
  if (role.position >= actor.roles.highest.position) return false;
  if (!actor.permissions.has(role.permissions)) return false;
  if (target && target.id !== actor.id && target.roles.highest.position >= actor.roles.highest.position) return false;
  if (target && target.id === actor.guild.ownerId) return false;
  return true;
}

export async function safeAddRole(
  member: GuildMember,
  roleId: string,
  reason?: string,
  /** Only for a person giving the role themselves, after canManageRole: they may give staff roles. */
  options: { allowStaffRoles?: boolean } = {},
): Promise<RoleActionResult> {
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return { ok: false, reason: "Role not found." };
  if (member.roles.cache.has(roleId)) return { ok: true };
  const bot = member.guild.members.me;
  if (!bot?.permissions.has("ManageRoles")) return { ok: false, reason: "Bot lacks Manage Roles." };
  if (role.managed) return { ok: false, reason: "Role is managed by an integration." };
  if (role.position >= bot.roles.highest.position) return { ok: false, reason: "Role is above the bot." };
  if (!options.allowStaffRoles && isStaffRole(role)) return { ok: false, reason: "Roles with staff permissions can't be given out automatically." };
  await member.roles.add(roleId, reason ?? "Dreamliner");
  return { ok: true };
}

export async function safeRemoveRole(member: GuildMember, roleId: string, reason?: string): Promise<RoleActionResult> {
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return { ok: false, reason: "Role not found." };
  if (!member.roles.cache.has(roleId)) return { ok: true };
  const bot = member.guild.members.me;
  if (!bot?.permissions.has("ManageRoles")) return { ok: false, reason: "Bot lacks Manage Roles." };
  if (role.position >= bot.roles.highest.position) return { ok: false, reason: "Role is above the bot." };
  await member.roles.remove(roleId, reason ?? "Dreamliner");
  return { ok: true };
}

export async function safeToggleRole(
  member: GuildMember,
  roleId: string,
  reason?: string,
): Promise<RoleActionResult & { added?: boolean }> {
  if (member.roles.cache.has(roleId)) {
    const result = await safeRemoveRole(member, roleId, reason);
    return { ...result, added: false };
  }
  const result = await safeAddRole(member, roleId, reason);
  return { ...result, added: true };
}
