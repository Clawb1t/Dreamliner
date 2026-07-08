import type { GuildMember, Role } from "discord.js";

export type RoleActionResult = { ok: true } | { ok: false; reason: string };

export function canManageRole(actor: GuildMember, role: Role): boolean {
  if (!actor.guild.members.me?.permissions.has("ManageRoles")) return false;
  if (role.managed) return false;
  if (role.id === actor.guild.id) return false;
  if (role.position >= actor.guild.members.me!.roles.highest.position) return false;
  if (role.position >= actor.roles.highest.position && actor.id !== actor.guild.ownerId) return false;
  return true;
}

export async function safeAddRole(member: GuildMember, roleId: string, reason?: string): Promise<RoleActionResult> {
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return { ok: false, reason: "Role not found." };
  if (member.roles.cache.has(roleId)) return { ok: true };
  const bot = member.guild.members.me;
  if (!bot?.permissions.has("ManageRoles")) return { ok: false, reason: "Bot lacks Manage Roles." };
  if (role.managed) return { ok: false, reason: "Role is managed by an integration." };
  if (role.position >= bot.roles.highest.position) return { ok: false, reason: "Role is above the bot." };
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
