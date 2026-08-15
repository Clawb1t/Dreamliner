import type { GuildMember, PartialGuildMember, Role } from "discord.js";
import {
  zMemberIdentityConfig,
  type MemberIdentityConfig,
} from "../../../config/schemas/plugins.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { getMemberIdentity, upsertMemberIdentity, type MemberIdentitySnapshot } from "./store.js";

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

export function getMemberIdentityConfig(guildConfig: Parameters<typeof resolvePluginConfig>[0]): MemberIdentityConfig {
  return parsePluginConfig(zMemberIdentityConfig, resolvePluginConfig(guildConfig, "member_identity"));
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

async function applySnapshot(
  member: GuildMember,
  snapshot: MemberIdentitySnapshot,
  config: MemberIdentityConfig,
): Promise<void> {
  if (config.restore_roles) {
    const roles = filterRestorableRoles(member, snapshot.roleIds, config);
    if (roles.length > 0) {
      await member.roles.add(roles, RESTORE_REASON).catch(() => null);
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
}

export async function restoreMemberIdentity(member: GuildMember): Promise<void> {
  const guild = member.guild;
  if (!guild) return;

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, "member_identity")) return;

  const config = getMemberIdentityConfig(guildConfig);
  if (config.ignore_bots && member.user.bot) return;
  if (!config.restore_nickname && !config.restore_roles && !config.restore_timeout) return;

  const snapshot = await getMemberIdentity(guild.id, member.id);
  if (!snapshot) return;

  const run = async () => {
    const stillEnabled = pluginEnabled(await configManager.getEffectiveConfig(guild.id), "member_identity");
    if (!stillEnabled) return;
    const refreshed = await guild.members.fetch(member.id).catch(() => null);
    if (!refreshed) return;
    await applySnapshot(refreshed, snapshot, config);
  };

  if (config.delay_ms > 0) {
    setTimeout(() => void run(), config.delay_ms);
    return;
  }
  await run();
}
