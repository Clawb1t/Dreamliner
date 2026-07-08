import type { GuildMember, Role } from "discord.js";
import type { AutoroleConfig, AutoroleRoleEntry, NormalizedAutoroleEntry } from "../../../config/schemas/autorole.js";
import { parseDuration } from "../../infraction/functions/duration.js";

export function resolveRoleDelayMs(entry: Pick<AutoroleRoleEntry, "delay_ms" | "delay">): number {
  if (entry.delay) {
    const parsed = parseDuration(entry.delay);
    if (parsed !== null) return parsed;
  }
  return entry.delay_ms;
}

export function normalizeAutoroleEntries(config: AutoroleConfig): NormalizedAutoroleEntry[] {
  return config.roles.map((entry) => {
    if (typeof entry === "string") {
      return { roleId: entry, delayMs: 0 };
    }
    return { roleId: entry.role, delayMs: resolveRoleDelayMs(entry) };
  });
}

export function filterAssignableRoles(member: GuildMember, roleIds: string[]): Role[] {
  const me = member.guild.members.me;
  if (!me) return [];

  const highest = me.roles.highest.position;
  return roleIds
    .map((id) => member.guild.roles.cache.get(id))
    .filter((role): role is Role => {
      if (!role) return false;
      if (member.roles.cache.has(role.id)) return false;
      if (!role.editable) return false;
      if (role.position >= highest) return false;
      return true;
    });
}

export async function applyAutoroles(member: GuildMember, roleIds: string[]): Promise<void> {
  const roles = filterAssignableRoles(member, roleIds);
  if (roles.length === 0) return;
  await member.roles.add(roles, "Dreamliner autorole").catch(() => null);
}

function scheduleSingleAutorole(member: GuildMember, roleId: string, delayMs: number): void {
  const run = async () => {
    const refreshed = await member.guild.members.fetch(member.id).catch(() => null);
    if (!refreshed || refreshed.user.bot) return;
    await applyAutoroles(refreshed, [roleId]);
  };

  if (delayMs > 0) {
    setTimeout(() => void run(), delayMs);
  } else {
    void run();
  }
}

export function scheduleAutoroles(member: GuildMember, config: AutoroleConfig): void {
  const entries = normalizeAutoroleEntries(config);
  for (const entry of entries) {
    scheduleSingleAutorole(member, entry.roleId, entry.delayMs);
  }
}
