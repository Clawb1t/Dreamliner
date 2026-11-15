import type { GuildMember, PartialGuildMember, Role } from "discord.js";
import {
  zMemberIdentityConfig,
  type MemberIdentityConfig,
} from "../../../config/schemas/plugins.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { getMemberIdentity, upsertMemberIdentity, type MemberIdentitySnapshot } from "./store.js";
import { capMap, createPruner } from "../../../core/mapPrune.js";

const RESTORE_REASON = "Dreamliner member identity";

function roleIdsFromMember(member: GuildMember | PartialGuildMember): string[] {
  return [...member.roles.cache.keys()].filter((id) => id !== member.guild.id);
}

function sameRoleSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Set(b);
  return a.every((id) => other.has(id));
}

function snapshotFromMember(member: GuildMember) {
  return {
    nickname: member.nickname ?? "",
    roleIds: roleIdsFromMember(member),
    timeoutUntil: member.communicationDisabledUntilTimestamp ?? null,
    username: member.user?.username ?? "",
  };
}

export function getMemberIdentityConfig(guildConfig: Parameters<typeof getPluginSettings>[0]): MemberIdentityConfig {
  return parsePluginConfig(zMemberIdentityConfig, getPluginSettings(guildConfig, "member_identity"));
}

export async function saveMemberIdentity(
  member: GuildMember | PartialGuildMember,
  options: { mergeIfSparse?: boolean } = {},
): Promise<void> {
  if (member.partial) return;
  const guild = member.guild;
  if (!guild) return;

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, "member_identity")) return;

  const config = getMemberIdentityConfig(guildConfig);
  if (config.ignore_bots && member.user.bot) return;

  const next = snapshotFromMember(member);
  if (options.mergeIfSparse) {
    const existing = await getMemberIdentity(guild.id, member.id);
    if (existing && next.roleIds.length === 0 && existing.roleIds.length > 0) {
      next.roleIds = existing.roleIds;
    }
    if (existing && !next.timeoutUntil && existing.timeoutUntil) {
      next.timeoutUntil = existing.timeoutUntil;
    }
    if (existing && !next.username && existing.username) {
      next.username = existing.username;
    }
  }

  await upsertMemberIdentity({
    guildId: guild.id,
    userId: member.id,
    ...next,
  });
}

export function identityChanged(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember): boolean {
  if (oldMember.partial) return true;
  if ((oldMember.nickname ?? "") !== (newMember.nickname ?? "")) return true;
  if (oldMember.communicationDisabledUntilTimestamp !== newMember.communicationDisabledUntilTimestamp) return true;
  return !sameRoleSet(roleIdsFromMember(oldMember), roleIdsFromMember(newMember));
}

function filterRestorableRoles(member: GuildMember, roleIds: string[], config: MemberIdentityConfig): Role[] {
  const me = member.guild.members.me;
  if (!me) return [];

  const ignored = new Set(config.ignored_roles);
  const highest = me.roles.highest.position;

  return roleIds
    .filter((id) => !ignored.has(id))
    .map((id) => member.guild.roles.cache.get(id))
    .filter((role): role is Role => {
      if (!role) return false;
      if (member.roles.cache.has(role.id)) return false;
      if (config.skip_managed_roles && role.managed) return false;
      if (!role.editable) return false;
      if (role.position >= highest) return false;
      return true;
    });
}

/** Applies a snapshot; resolves true when at least one role was given back. */
async function applySnapshot(
  member: GuildMember,
  snapshot: MemberIdentitySnapshot,
  config: MemberIdentityConfig,
): Promise<boolean> {
  let restoredRoles = false;
  if (config.restore_roles) {
    const roles = filterRestorableRoles(member, snapshot.roleIds, config);
    if (roles.length > 0) {
      restoredRoles = Boolean(await member.roles.add(roles, RESTORE_REASON).catch(() => null));
    }
  }

  if (config.restore_nickname && snapshot.nickname && member.nickname !== snapshot.nickname) {
    await member.setNickname(snapshot.nickname, RESTORE_REASON).catch(() => null);
  }

  if (config.restore_timeout && snapshot.timeoutUntil && snapshot.timeoutUntil > Date.now()) {
    const current = member.communicationDisabledUntilTimestamp ?? 0;
    if (current < snapshot.timeoutUntil) {
      await member.disableCommunicationUntil(snapshot.timeoutUntil, RESTORE_REASON).catch(() => null);
    }
  }
  return restoredRoles;
}

async function runRestore(member: GuildMember): Promise<boolean> {
  const guild = member.guild;
  if (!guild) return false;

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, "member_identity")) return false;

  const config = getMemberIdentityConfig(guildConfig);
  if (config.ignore_bots && member.user.bot) return false;
  if (!config.restore_nickname && !config.restore_roles && !config.restore_timeout) return false;

  const snapshot = await getMemberIdentity(guild.id, member.id);
  if (!snapshot) return false;

  if (config.delay_ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.delay_ms));
  }
  const stillEnabled = pluginEnabled(await configManager.getEffectiveConfig(guild.id), "member_identity");
  if (!stillEnabled) return false;
  const refreshed = await guild.members.fetch(member.id).catch(() => null);
  if (!refreshed) return false;
  return applySnapshot(refreshed, snapshot, config);
}

/** One restore per join, shared by every caller (see restoreMemberIdentity). Settled entries are
 *  kept a while so a late caller still gets the same answer instead of restoring again. */
const restores = new Map<string, { promise: Promise<boolean>; settledAt: number | null }>();
const RESTORE_REMEMBER_MS = 24 * 60 * 60_000;
const pruneRestores = createPruner(
  restores,
  (entry, now) => entry.settledAt !== null && now - entry.settledAt >= RESTORE_REMEMBER_MS,
  10 * 60_000,
);

function restoreKey(member: GuildMember): string {
  return `${member.guild.id}:${member.id}:${member.joinedTimestamp ?? 0}`;
}

/**
 * Restores a rejoining member's saved nickname, roles and timeout (after `delay_ms`). Resolves
 * true when roles were given back. Idempotent per join: Member Identity's own GuildMemberAdd
 * handler and Autorole's `skip_if_restored` check both call this, and whichever runs first starts
 * the restore while the other awaits the same promise, so handler order doesn't matter.
 */
export function restoreMemberIdentity(member: GuildMember): Promise<boolean> {
  const key = restoreKey(member);
  const existing = restores.get(key);
  if (existing) return existing.promise;

  pruneRestores();
  capMap(restores, 10_000);
  const entry: { promise: Promise<boolean>; settledAt: number | null } = { promise: Promise.resolve(false), settledAt: null };
  entry.promise = runRestore(member)
    .catch(() => false)
    .then((restored) => {
      entry.settledAt = Date.now();
      return restored;
    });
  restores.set(key, entry);
  return entry.promise;
}

/** The outcome of this join's restore if one already ran or is running, without starting one. */
export function peekMemberRestore(member: GuildMember): Promise<boolean> | null {
  return restores.get(restoreKey(member))?.promise ?? null;
}
