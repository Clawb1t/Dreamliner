import { eq, inArray } from "drizzle-orm";
import { PermissionFlagsBits, type GuildMember } from "discord.js";
import { getDb } from "../db/client.js";
import { guildPermissionRoleGrants, guildPermissionRoleTargets, guildPermissionRoles } from "../db/schema.js";
import { permissionRoleManager } from "../config/permissionRoleManager.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import { getPluginBaseConfig, stripUnknownPluginKeys } from "./pluginSchemas.js";
import { grantKeyFor } from "./permissionCatalog.js";

// Dreamliner Roles resolution — replaces core/permissions.ts. A member's effective permissions
// are the OR of every role they belong to: the implicit "Member" role (applies to everyone,
// no target row needed) plus any role where the member themself, or one of their Discord roles,
// is an assigned target. No channel/category scoping, no numeric levels — see
// docs/permissions.md and the plan this replaced for the full rationale.

export type MemberPermissionRole = {
  id: number;
  name: string;
  builtIn: "member" | "moderator" | "admin" | null;
  grantKeys: Set<string>;
};

type GuildRoleCacheEntry = {
  id: number;
  name: string;
  builtIn: "member" | "moderator" | "admin" | null;
  targets: { type: "role" | "user"; id: string }[];
  grantKeys: Set<string>;
};

const guildRoleCache = new Map<string, GuildRoleCacheEntry[]>();

permissionRoleManager.onChange((guildId) => {
  guildRoleCache.delete(guildId);
});

async function loadGuildRoles(guildId: string): Promise<GuildRoleCacheEntry[]> {
  const cached = guildRoleCache.get(guildId);
  if (cached) return cached;

  await permissionRoleManager.ensureDefaultRoles(guildId);

  const db = getDb();
  const roles = db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.guildId, guildId)).all();
  const roleIds = roles.map((r) => r.id);
  const targets = roleIds.length
    ? db.select().from(guildPermissionRoleTargets).where(inArray(guildPermissionRoleTargets.roleId, roleIds)).all()
    : [];
  const grants = roleIds.length
    ? db.select().from(guildPermissionRoleGrants).where(inArray(guildPermissionRoleGrants.roleId, roleIds)).all()
    : [];

  const targetsByRole = new Map<number, { type: "role" | "user"; id: string }[]>();
  for (const t of targets) {
    const list = targetsByRole.get(t.roleId) ?? [];
    list.push({ type: t.targetType as "role" | "user", id: t.targetId });
    targetsByRole.set(t.roleId, list);
  }
  const grantsByRole = new Map<number, Set<string>>();
  for (const g of grants) {
    const set = grantsByRole.get(g.roleId) ?? new Set<string>();
    set.add(g.grantKey);
    grantsByRole.set(g.roleId, set);
  }

  const entries: GuildRoleCacheEntry[] = roles.map((role) => ({
    id: role.id,
    name: role.name,
    builtIn: (role.builtIn as "member" | "moderator" | "admin" | null) ?? null,
    targets: targetsByRole.get(role.id) ?? [],
    grantKeys: grantsByRole.get(role.id) ?? new Set<string>(),
  }));
  guildRoleCache.set(guildId, entries);
  return entries;
}

/** Owner / Discord Administrator / Manage Server holders always pass every check, independent of role assignment — turn off per-guild with `admin_bypass: false`. */
export function hasAdminBypass(member: GuildMember, guildConfig: GuildConfig): boolean {
  if (guildConfig.admin_bypass === false) return false;
  return (
    member.id === member.guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

/** Every Dreamliner Role this member belongs to: the implicit Member role, plus any role targeting them directly or via a Discord role they hold. */
export async function getMemberPermissionRoles(guildId: string, member: GuildMember): Promise<MemberPermissionRole[]> {
  const roles = await loadGuildRoles(guildId);
  const memberRoleIds = member.roles.cache;
  const belongsTo = roles.filter((role) => {
    if (role.builtIn === "member") return true;
    return role.targets.some((t) => (t.type === "user" ? t.id === member.id : memberRoleIds.has(t.id)));
  });
  return belongsTo.map((role) => ({ id: role.id, name: role.name, builtIn: role.builtIn, grantKeys: role.grantKeys }));
}

/** OR across every role the member belongs to; admin_bypass short-circuits to true without even resolving roles. */
export async function hasPermission(
  guildId: string,
  pluginName: string,
  permission: string,
  member: GuildMember,
  guildConfig: GuildConfig,
): Promise<boolean> {
  if (hasAdminBypass(member, guildConfig)) return true;
  const grantKey = grantKeyFor(pluginName, permission);
  const roles = await getMemberPermissionRoles(guildId, member);
  return roles.some((role) => role.grantKeys.has(grantKey));
}

/**
 * A plugin's non-permission settings only — schema defaults merged with the guild's stored
 * config, `can_*` keys left out entirely (they're no longer meaningful without a member to
 * resolve roles for). For code paths with no member in context (event handlers, bot-driven
 * actions) that only need a threshold/toggle, not a permission check.
 */
export function getPluginSettings(guildConfig: GuildConfig, pluginName: string): Record<string, unknown> {
  const section = guildConfig.plugins[pluginName as keyof typeof guildConfig.plugins] as
    | { config?: Record<string, unknown> }
    | undefined;

  const config: Record<string, unknown> = { ...getPluginBaseConfig(pluginName) };
  if (section?.config) {
    for (const [key, value] of Object.entries(section.config)) {
      if (key.startsWith("can_")) continue; // permission grants come from roles, not stored config
      config[key] = value;
    }
  }
  return stripUnknownPluginKeys(pluginName, config);
}

/**
 * A plugin's effective config for this member: `getPluginSettings`'s non-permission values, with
 * every `can_*` flag they have via any Dreamliner Role OR'd on. Any `config.can_*` still sitting
 * in old stored YAML is ignored — permission grants only ever come from roles now, so a stale
 * upload can't reintroduce a legacy grant.
 */
export async function resolveEffectivePluginConfig(
  guildId: string,
  pluginName: string,
  member: GuildMember,
  guildConfig: GuildConfig,
): Promise<Record<string, unknown>> {
  const config = getPluginSettings(guildConfig, pluginName);
  const catalogKeys = Object.keys({ ...getPluginBaseConfig(pluginName) }).filter((key) => key.startsWith("can_"));

  const bypass = hasAdminBypass(member, guildConfig);
  const roles = bypass ? [] : await getMemberPermissionRoles(guildId, member);
  for (const key of catalogKeys) {
    if (bypass) {
      config[key] = true;
      continue;
    }
    const grantKey = grantKeyFor(pluginName, key);
    config[key] = roles.some((role) => role.grantKeys.has(grantKey));
  }

  return config;
}
