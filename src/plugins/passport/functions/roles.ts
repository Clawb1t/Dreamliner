import type { GuildMember } from "discord.js";
import type { PassportConfig } from "../../../config/schemas/passport.js";
import { safeAddRole, safeRemoveRole } from "../../../core/roles.js";
import { renderTemplate } from "../../../core/templates.js";

const REASON = "Dreamliner Passport";

function uniqueIds(ids: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function memberHasBypassRole(member: GuildMember, config: PassportConfig): boolean {
  return config.bypass_role_ids.some((id) => id && member.roles.cache.has(id));
}

export async function applyUnverifiedGate(member: GuildMember, config: PassportConfig): Promise<void> {
  const keep = new Set(uniqueIds([config.unverified_role_id, member.guild.id]));
  if (config.strip_roles_until_verified) {
    const toRemove = member.roles.cache.filter((role) => !keep.has(role.id) && !role.managed);
    for (const role of toRemove.values()) {
      await safeRemoveRole(member, role.id, `${REASON} gate`);
    }
  }
  if (config.unverified_role_id) {
    await safeAddRole(member, config.unverified_role_id, `${REASON} unverified`);
  }
}

export type PassportRewards = {
  roles: { id: string; name: string; color: string | null }[];
  removedRoles: string[];
  nickname: string | null;
};

function roleColor(color: number): string | null {
  return color === 0 ? null : `#${color.toString(16).padStart(6, "0")}`;
}

export async function applyVerifiedRewards(
  member: GuildMember,
  config: PassportConfig,
): Promise<PassportRewards> {
  const rewards: PassportRewards = { roles: [], removedRoles: [], nickname: null };

  const removeIds = uniqueIds([config.unverified_role_id, ...config.remove_role_ids]);
  for (const roleId of removeIds) {
    const role = member.guild.roles.cache.get(roleId);
    const result = await safeRemoveRole(member, roleId, `${REASON} verified`);
    if (result.ok && role) rewards.removedRoles.push(role.name);
  }
  for (const roleId of uniqueIds(config.grant_role_ids)) {
    const role = member.guild.roles.cache.get(roleId);
    const result = await safeAddRole(member, roleId, `${REASON} verified`);
    if (result.ok && role) {
      rewards.roles.push({ id: role.id, name: role.name, color: roleColor(role.color) });
    }
  }

  const nickTemplate = config.nickname.trim();
  if (!nickTemplate) return rewards;
  const nick = renderTemplate(nickTemplate, {
    member,
    user: member.user,
    guild: member.guild,
  })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  if (!nick || nick === member.nickname) return rewards;
  const renamed = await member.setNickname(nick, `${REASON} verified`).catch(() => null);
  if (renamed) rewards.nickname = nick;
  return rewards;
}

export async function applyRevoke(member: GuildMember, config: PassportConfig): Promise<void> {
  for (const roleId of uniqueIds(config.grant_role_ids)) {
    await safeRemoveRole(member, roleId, `${REASON} revoke`);
  }
  await applyUnverifiedGate(member, config);
}

export function accountAgeTooYoung(createdTimestamp: number, minSeconds: number): boolean {
  if (minSeconds <= 0) return false;
  return Date.now() - createdTimestamp < minSeconds * 1000;
}
