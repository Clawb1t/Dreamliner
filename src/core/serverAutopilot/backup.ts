/**
 * Server Autopilot structure backups: serialising a guild's roles and channels (with every
 * permission overwrite) and planning a restore from one. Pure; the build runner does the Discord work.
 */
import { protectedChannelIds, roleEditable, structureOf, type GuildSnapshot, type SnapChannel, type SnapKind, type SnapRole } from "./snapshot.js";
import type { SAStructure } from "./types.js";

export type BackupRole = Omit<SnapRole, "members">;
export type BackupOverwrite = { id: string; type: "role" | "member"; roleName: string | null; allow: string; deny: string };
export type BackupChannel = Omit<SnapChannel, "overwrites" | "hasMessages"> & { overwrites: BackupOverwrite[] };

export type SABackupStructure = {
  version: 1;
  guildId: string;
  guildName: string;
  takenAt: string;
  rulesChannelId: string | null;
  publicUpdatesChannelId: string | null;
  systemChannelId: string | null;
  roles: BackupRole[];
  channels: BackupChannel[];
};

export function serializeBackup(snap: GuildSnapshot, takenAt: Date): SABackupStructure {
  const roleNames = new Map(snap.roles.map((r) => [r.id, r.isEveryone ? "@everyone" : r.name]));
  return {
    version: 1,
    guildId: snap.id,
    guildName: snap.name,
    takenAt: takenAt.toISOString(),
    rulesChannelId: snap.rulesChannelId,
    publicUpdatesChannelId: snap.publicUpdatesChannelId,
    systemChannelId: snap.systemChannelId,
    roles: [...snap.roles]
      .sort((a, b) => b.position - a.position)
      .map(({ members: _members, ...role }) => role),
    channels: [...snap.channels]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(({ hasMessages: _has, overwrites, ...channel }) => ({
        ...channel,
        overwrites: overwrites.map((o) => ({ ...o, roleName: o.type === "role" ? (roleNames.get(o.id) ?? null) : null })),
      })),
  };
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** Reads a stored backup back, or null when it isn't one (corrupt or from a future version). */
export function parseBackupStructure(json: string): SABackupStructure | null {
  try {
    const data = JSON.parse(json) as SABackupStructure;
    if (!data || data.version !== 1 || !isStr(data.guildId) || !Array.isArray(data.roles) || !Array.isArray(data.channels)) return null;
    if (!data.roles.every((r) => isStr(r.id) && isStr(r.name) && isStr(r.permissions))) return null;
    if (!data.channels.every((c) => isStr(c.id) && isStr(c.name) && Array.isArray(c.overwrites))) return null;
    return data;
  } catch {
    return null;
  }
}

/** A backup as the dashboard's structure view. */
export function backupStructureView(backup: SABackupStructure, bot: GuildSnapshot["bot"]): SAStructure {
  return structureOf({
    channels: backup.channels.map((c) => ({ ...c, hasMessages: false, overwrites: c.overwrites.map(({ roleName: _n, ...o }) => o) })),
    roles: backup.roles.map((r) => ({ ...r, members: 0 })),
    bot,
    rulesChannelId: backup.rulesChannelId,
    publicUpdatesChannelId: backup.publicUpdatesChannelId,
    systemChannelId: backup.systemChannelId,
  });
}

export function backupCounts(backup: SABackupStructure): { roles: number; channels: number } {
  return { roles: backup.roles.filter((r) => !r.isEveryone).length, channels: backup.channels.length };
}

// ── Restore planning ────────────────────────────────────────────────────────

export type RestoreRoleAction = {
  backupId: string;
  action: "create" | "update" | "skip";
  roleId: string | null;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  position: number;
  changes: string[];
};

export type RestoreChannelAction = {
  backupId: string;
  action: "create" | "update" | "skip";
  channelId: string | null;
  kind: SnapKind;
  rawType: number;
  name: string;
  parentBackupId: string | null;
  topic: string;
  nsfw: boolean;
  slowmode: number;
  bitrate: number;
  userLimit: number;
  position: number;
  overwrites: BackupOverwrite[];
  changes: string[];
};

export type RestorePlan = {
  roles: RestoreRoleAction[];
  categories: RestoreChannelAction[];
  channels: RestoreChannelAction[];
  deleteChannels: Array<{ id: string; name: string; kind: SnapKind }>;
  deleteRoles: Array<{ id: string; name: string }>;
  warnings: string[];
};

/** Bits the bot can't set stay as they are now (or off, for a role being recreated). */
function clampPermissions(wanted: bigint, current: bigint, botPerms: bigint, botAdmin: boolean): bigint {
  if (botAdmin) return wanted;
  return (wanted & botPerms) | (current & ~botPerms);
}

/**
 * Restoring: roles and channels that still exist (same id) get their backed-up settings back,
 * missing ones are recreated. Things added after the backup are only removed with `removeAdded`.
 * Discord-managed, protected and above-the-bot items are never touched.
 */
export function computeRestorePlan(backup: SABackupStructure, snap: GuildSnapshot, removeAdded: boolean): RestorePlan {
  const warnings: string[] = [];
  const botPerms = BigInt(snap.bot.permissions);
  const botAdmin = snap.bot.administrator;
  const liveRoles = new Map(snap.roles.map((r) => [r.id, r]));
  const liveChannels = new Map(snap.channels.map((c) => [c.id, c]));

  const roles: RestoreRoleAction[] = [];
  let skippedRoles = 0;
  for (const role of backup.roles) {
    if (role.isEveryone || role.managed || role.isBooster) continue;
    const live = liveRoles.get(role.id);
    const base = { backupId: role.id, name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, position: role.position };
    if (!live) {
      roles.push({ ...base, action: "create", roleId: null, permissions: clampPermissions(BigInt(role.permissions), 0n, botPerms, botAdmin).toString(), changes: [] });
      continue;
    }
    if (!roleEditable(snap, live)) {
      skippedRoles += 1;
      roles.push({ ...base, action: "skip", roleId: live.id, permissions: live.permissions, changes: [] });
      continue;
    }
    const permissions = clampPermissions(BigInt(role.permissions), BigInt(live.permissions), botPerms, botAdmin);
    const changes: string[] = [];
    if (live.name !== role.name) changes.push("name");
    if (live.color !== role.color) changes.push("color");
    if (live.hoist !== role.hoist) changes.push("hoist");
    if (live.mentionable !== role.mentionable) changes.push("mentionable");
    if (BigInt(live.permissions) !== permissions) changes.push("permissions");
    roles.push({ ...base, action: changes.length ? "update" : "skip", roleId: live.id, permissions: permissions.toString(), changes });
  }
  if (skippedRoles) warnings.push(`${skippedRoles} role${skippedRoles === 1 ? " is" : "s are"} above Dreamliner's role and can't be restored.`);

  const toAction = (channel: BackupChannel): RestoreChannelAction => {
    const live = liveChannels.get(channel.id);
    const base = {
      backupId: channel.id,
      kind: channel.kind,
      rawType: channel.rawType,
      name: channel.name,
      parentBackupId: channel.parentId,
      topic: channel.topic,
      nsfw: channel.nsfw,
      slowmode: channel.slowmode,
      bitrate: channel.bitrate,
      userLimit: channel.userLimit,
      position: channel.position,
      overwrites: channel.overwrites,
    };
    if (!live) return { ...base, action: "create", channelId: null, changes: [] };
    const changes: string[] = [];
    if (live.name !== channel.name) changes.push("name");
    if (live.topic !== channel.topic && channel.kind !== "category") changes.push("topic");
    if (live.nsfw !== channel.nsfw) changes.push("nsfw");
    if (live.slowmode !== channel.slowmode) changes.push("slowmode");
    if (live.userLimit !== channel.userLimit) changes.push("user limit");
    if ((live.parentId ?? null) !== (channel.parentId ?? null)) changes.push("move");
    const sig = (list: Array<{ id: string; allow: string; deny: string }>) => list.map((o) => `${o.id}:${o.allow}:${o.deny}`).sort().join("|");
    if (sig(live.overwrites) !== sig(channel.overwrites)) changes.push("permissions");
    return { ...base, action: changes.length ? "update" : "skip", channelId: live.id, changes };
  };
  const restorable = backup.channels.filter((c) => c.kind !== "other");
  const categories = restorable.filter((c) => c.kind === "category").map(toAction);
  const channels = restorable.filter((c) => c.kind !== "category").map(toAction);

  const deleteChannels: RestorePlan["deleteChannels"] = [];
  const deleteRoles: RestorePlan["deleteRoles"] = [];
  if (removeAdded) {
    const backupChannelIds = new Set(backup.channels.map((c) => c.id));
    const protectedIds = protectedChannelIds(snap);
    for (const c of snap.channels) {
      if (backupChannelIds.has(c.id) || protectedIds.has(c.id) || c.kind === "other") continue;
      deleteChannels.push({ id: c.id, name: c.name, kind: c.kind });
    }
    deleteChannels.sort((a, b) => Number(a.kind === "category") - Number(b.kind === "category"));
    const backupRoleIds = new Set(backup.roles.map((r) => r.id));
    for (const r of snap.roles) {
      if (backupRoleIds.has(r.id) || !roleEditable(snap, r)) continue;
      deleteRoles.push({ id: r.id, name: r.name });
    }
  }
  return { roles, categories, channels, deleteChannels, deleteRoles, warnings };
}
