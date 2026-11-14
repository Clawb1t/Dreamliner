import { PermissionFlagsBits, type Client, type Guild, type GuildMember } from "discord.js";
import { configManager } from "../config/manager.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { getMemberIdentityConfig } from "../plugins/member_identity/functions/handlers.js";
import { getMemberIdentity } from "../plugins/member_identity/functions/store.js";
import {
  previewIdentityRestore,
  type RestoreBlockReason,
  type RestoreRoleFacts,
} from "../plugins/member_identity/functions/preview.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";

/**
 * The website's identity card page (/identity/:guildId/:userId): what Member Identity has saved
 * about one person in one server, and what would come back if they rejoined.
 *
 * Anyone who is currently in the server may look up anyone's card there (the viewer check runs in
 * dashboardBridge.ts before this is called). Everything here is read from that one server: its
 * own snapshot row, its own roles, its own config. Nothing is written.
 */

export type IdentityCardRole = {
  id: string;
  name: string | null;
  /** "#rrggbb", or null for a role with no colour. */
  color: string | null;
  position: number;
  deleted: boolean;
  managed: boolean;
  restores: boolean;
  reason: RestoreBlockReason | null;
};

export type IdentityCardPayload = {
  ok: true;
  guild: { id: string; name: string; iconUrl: string | null };
  viewerIsSelf: boolean;
  user: {
    id: string;
    username: string;
    globalName: string | null;
    avatarUrl: string;
    bot: boolean;
    inServer: boolean;
    joinedAt: string | null;
    currentNickname: string | null;
    isOwner: boolean;
  };
  plugin: {
    enabled: boolean;
    saveOnLeave: boolean;
    saveOnUpdate: boolean;
    restoreNickname: boolean;
    restoreRoles: boolean;
    restoreTimeout: boolean;
    skipManagedRoles: boolean;
    ignoreBots: boolean;
    delayMs: number;
  };
  saved: {
    nickname: string;
    username: string;
    timeoutUntil: string | null;
    /** The saved timeout hasn't run out yet. */
    timeoutActive: boolean;
    updatedAt: string;
    roles: IdentityCardRole[];
  } | null;
  restore: {
    anything: boolean;
    blockedReason: RestoreBlockReason | null;
    nickname: { restores: boolean; reason: RestoreBlockReason | null };
    timeout: { restores: boolean; reason: RestoreBlockReason | null };
  } | null;
};

/**
 * A member who is in the server right now. The shared lookup in people.ts remembers answers for a
 * few minutes, so a hit that has since left the gateway cache (they left) is checked again.
 */
export async function currentGuildMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  const remembered = await fetchMemberCached(guild, userId);
  if (!remembered) return null;
  if (guild.members.cache.has(userId)) return remembered;
  return guild.members.fetch(userId).catch(() => null);
}

function hexColor(color: number): string | null {
  return color ? `#${color.toString(16).padStart(6, "0")}` : null;
}

export async function buildIdentityCard(
  client: Client,
  guild: Guild,
  targetId: string,
  viewerId: string,
): Promise<IdentityCardPayload | null> {
  const [user, member, snapshot, guildConfig] = await Promise.all([
    fetchUserCached(client, targetId),
    currentGuildMember(guild, targetId),
    getMemberIdentity(guild.id, targetId),
    configManager.getEffectiveConfig(guild.id),
  ]);
  if (!user) return null;

  const enabled = pluginEnabled(guildConfig, "member_identity");
  const config = getMemberIdentityConfig(guildConfig);
  const isOwner = guild.ownerId === targetId;

  let saved: IdentityCardPayload["saved"] = null;
  let restore: IdentityCardPayload["restore"] = null;

  if (snapshot) {
    const roleFacts = new Map<string, RestoreRoleFacts>();
    for (const id of snapshot.roleIds) {
      const role = guild.roles.cache.get(id);
      roleFacts.set(id, {
        id,
        exists: Boolean(role),
        managed: role?.managed ?? false,
        position: role?.position ?? 0,
      });
    }

    const me = guild.members.me;
    const now = Date.now();
    const preview = previewIdentityRestore({
      pluginEnabled: enabled,
      config,
      snapshot,
      roles: roleFacts,
      bot: me
        ? {
            highestPosition: me.roles.highest.position,
            manageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
            manageNicknames: me.permissions.has(PermissionFlagsBits.ManageNicknames),
            moderateMembers: me.permissions.has(PermissionFlagsBits.ModerateMembers),
          }
        : null,
      targetIsBot: user.bot,
      targetIsOwner: isOwner,
      guildId: guild.id,
      now,
    });

    const roles: IdentityCardRole[] = preview.roles.map((entry) => {
      const role = guild.roles.cache.get(entry.id);
      return {
        id: entry.id,
        name: role?.name ?? null,
        color: role ? hexColor(role.color) : null,
        position: role?.position ?? -1,
        deleted: !role,
        managed: role?.managed ?? false,
        restores: entry.restores,
        reason: entry.reason,
      };
    });
    roles.sort((a, b) => b.position - a.position);

    saved = {
      nickname: snapshot.nickname,
      username: snapshot.username,
      timeoutUntil: snapshot.timeoutUntil ? new Date(snapshot.timeoutUntil).toISOString() : null,
      timeoutActive: Boolean(snapshot.timeoutUntil && snapshot.timeoutUntil > now),
      updatedAt: snapshot.updatedAt.toISOString(),
      roles,
    };
    restore = {
      anything: preview.anything,
      blockedReason: preview.blockedReason,
      nickname: preview.nickname,
      timeout: preview.timeout,
    };
  }

  return {
    ok: true,
    guild: { id: guild.id, name: guild.name, iconUrl: guild.iconURL({ size: 128 }) },
    viewerIsSelf: viewerId === targetId,
    user: {
      id: user.id,
      username: user.username,
      globalName: user.globalName ?? null,
      avatarUrl: user.displayAvatarURL({ size: 256 }),
      bot: user.bot,
      inServer: Boolean(member),
      joinedAt: member?.joinedAt?.toISOString() ?? null,
      currentNickname: member?.nickname ?? null,
      isOwner,
    },
    plugin: {
      enabled,
      saveOnLeave: config.save_on_leave,
      saveOnUpdate: config.save_on_update,
      restoreNickname: config.restore_nickname,
      restoreRoles: config.restore_roles,
      restoreTimeout: config.restore_timeout,
      skipManagedRoles: config.skip_managed_roles,
      ignoreBots: config.ignore_bots,
      delayMs: config.delay_ms,
    },
    saved,
    restore,
  };
}
