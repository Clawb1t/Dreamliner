import { PermissionFlagsBits, type Client, type Guild, type GuildMember } from "discord.js";
import { configManager } from "../config/manager.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { getMemberIdentityConfig, saveMemberIdentity } from "../plugins/member_identity/functions/handlers.js";
import {
  deleteMemberIdentity,
  getMemberIdentity,
  getMemberIdentityStats,
  listMemberIdentities,
  type MemberIdentityListFilter,
  type MemberIdentityListQuery,
  type MemberIdentityListSort,
  type MemberIdentityStats,
} from "../plugins/member_identity/functions/store.js";
import {
  previewIdentityRestore,
  type RestoreBlockReason,
  type RestoreRoleFacts,
} from "../plugins/member_identity/functions/preview.js";
import { trackDashboardAction } from "./dashboardAudit.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import { getWebUserNameHistory, type WebNameHistoryEntry } from "./webNameHistory.js";

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

// ── Staff Identity Lookup (dashboard, Manage Server) ────────────────────────────
// The dashboard's list of saved identities and one member's detail. The Manage Server check runs
// in dashboardBridge.ts before any of these are called. Every query is scoped to `guild.id`.

export type StaffIdentityRow = {
  userId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  inServer: boolean;
  savedNickname: string;
  savedUsername: string;
  roleCount: number;
  timeoutUntil: string | null;
  timeoutActive: boolean;
  updatedAt: string;
};

export type StaffIdentityListPayload = {
  ok: true;
  total: number;
  rows: StaffIdentityRow[];
  stats: MemberIdentityStats;
  plugin: { enabled: boolean; saveOnLeave: boolean; saveOnUpdate: boolean };
};

const LIST_FILTERS: readonly MemberIdentityListFilter[] = ["all", "roles", "nickname", "timeout", "empty"];
const LIST_SORTS: readonly MemberIdentityListSort[] = ["recent", "oldest", "roles", "name"];
const MAX_PAGE = 50;

export function parseStaffIdentityListQuery(url: URL): MemberIdentityListQuery {
  const filterRaw = url.searchParams.get("filter") ?? "all";
  const sortRaw = url.searchParams.get("sort") ?? "recent";
  const limitRaw = Number(url.searchParams.get("limit") ?? 25);
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 100),
    filter: (LIST_FILTERS as readonly string[]).includes(filterRaw) ? (filterRaw as MemberIdentityListFilter) : "all",
    sort: (LIST_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as MemberIdentityListSort) : "recent",
    limit: Number.isFinite(limitRaw) ? Math.min(MAX_PAGE, Math.max(1, Math.trunc(limitRaw))) : 25,
    offset: Number.isFinite(offsetRaw) ? Math.min(1_000_000, Math.max(0, Math.trunc(offsetRaw))) : 0,
  };
}

export async function buildStaffIdentityList(
  client: Client,
  guild: Guild,
  query: MemberIdentityListQuery,
): Promise<StaffIdentityListPayload> {
  const now = Date.now();
  const [page, stats, guildConfig] = await Promise.all([
    listMemberIdentities(guild.id, query, now),
    getMemberIdentityStats(guild.id, now),
    configManager.getEffectiveConfig(guild.id),
  ]);
  const config = getMemberIdentityConfig(guildConfig);

  const rows = await Promise.all(
    page.rows.map(async (row): Promise<StaffIdentityRow> => {
      const member = await currentGuildMember(guild, row.userId);
      const user = member?.user ?? (await fetchUserCached(client, row.userId));
      return {
        userId: row.userId,
        name: member?.displayName ?? user?.globalName ?? user?.username ?? (row.username || row.userId),
        username: user?.username ?? (row.username || null),
        avatarUrl: user?.displayAvatarURL({ size: 64 }) ?? null,
        inServer: Boolean(member),
        savedNickname: row.nickname,
        savedUsername: row.username,
        roleCount: row.roleCount,
        timeoutUntil: row.timeoutUntil ? new Date(row.timeoutUntil).toISOString() : null,
        timeoutActive: Boolean(row.timeoutUntil && row.timeoutUntil > now),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
  );

  return {
    ok: true,
    total: page.total,
    rows,
    stats,
    plugin: {
      enabled: pluginEnabled(guildConfig, "member_identity"),
      saveOnLeave: config.save_on_leave,
      saveOnUpdate: config.save_on_update,
    },
  };
}

export type StaffIdentityDetailPayload = {
  ok: true;
  card: IdentityCardPayload;
  names: WebNameHistoryEntry[];
};

/** One member's saved identity, restore preview and recorded name changes, for staff. */
export async function buildStaffIdentityDetail(
  client: Client,
  guild: Guild,
  targetId: string,
  viewerId: string,
): Promise<StaffIdentityDetailPayload | null> {
  const [card, history] = await Promise.all([
    buildIdentityCard(client, guild, targetId, viewerId),
    getWebUserNameHistory(guild, targetId, 25),
  ]);
  if (!card) return null;
  return { ok: true, card, names: history.entries };
}

/** Deletes one member's snapshot in this server. Resolves whether there was one. */
export async function clearStaffIdentity(client: Client, guild: Guild, targetId: string, actorId: string): Promise<boolean> {
  const existing = await getMemberIdentity(guild.id, targetId);
  if (!existing) return false;
  const deleted = await deleteMemberIdentity(guild.id, targetId);
  if (deleted) {
    trackDashboardAction(client, guild.id, actorId, {
      eventType: "dashboard_config",
      title: "Saved identity cleared",
      summary: `<@${actorId}> cleared the saved identity of <@${targetId}> (${existing.roleIds.length} role${existing.roleIds.length === 1 ? "" : "s"}${existing.nickname ? `, nickname "${existing.nickname}"` : ""}).`,
      targetId,
      payload: { plugin: "member_identity", action: "clear", userId: targetId },
    });
  }
  return deleted;
}

export type StaffIdentitySaveResult =
  | { ok: true }
  | { ok: false; code: "not_in_server" | "plugin_off" | "bots_ignored"; error: string };

/** Takes a fresh snapshot of a member who is in the server right now. */
export async function saveStaffIdentityNow(client: Client, guild: Guild, targetId: string, actorId: string): Promise<StaffIdentitySaveResult> {
  const member = await currentGuildMember(guild, targetId);
  if (!member) return { ok: false, code: "not_in_server", error: "They aren't in the server, so there's nothing to save." };
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, "member_identity")) {
    return { ok: false, code: "plugin_off", error: "Turn Member Identity on first." };
  }
  if (getMemberIdentityConfig(guildConfig).ignore_bots && member.user.bot) {
    return { ok: false, code: "bots_ignored", error: "Bots are skipped. Turn off Skip bots to save them." };
  }
  await saveMemberIdentity(member);
  trackDashboardAction(client, guild.id, actorId, {
    eventType: "dashboard_config",
    title: "Saved identity updated",
    summary: `<@${actorId}> saved the current roles and nickname of <@${targetId}>.`,
    targetId,
    payload: { plugin: "member_identity", action: "save", userId: targetId },
  });
  return { ok: true };
}
