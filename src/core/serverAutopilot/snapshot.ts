/**
 * A plain-data picture of a guild's structure (channels, roles, the bot's standing), so plans,
 * backups and restores are computed by pure functions that tests can feed directly.
 */
import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type GuildBasedChannel } from "discord.js";
import type { SAExistingChannelType, SAStructure } from "./types.js";

export type SnapKind = SAExistingChannelType | "category";

export type SnapOverwrite = { id: string; type: "role" | "member"; allow: string; deny: string };

export type SnapChannel = {
  id: string;
  name: string;
  kind: SnapKind;
  /** discord.js ChannelType number, for exact recreation. */
  rawType: number;
  parentId: string | null;
  position: number;
  topic: string;
  nsfw: boolean;
  slowmode: number;
  bitrate: number;
  userLimit: number;
  hasMessages: boolean;
  overwrites: SnapOverwrite[];
};

export type SnapRole = {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  position: number;
  managed: boolean;
  isEveryone: boolean;
  isBooster: boolean;
  members: number;
};

export type GuildSnapshot = {
  id: string;
  name: string;
  ownerId: string;
  community: boolean;
  rulesChannelId: string | null;
  publicUpdatesChannelId: string | null;
  systemChannelId: string | null;
  safetyAlertsChannelId: string | null;
  channels: SnapChannel[];
  roles: SnapRole[];
  bot: { userId: string; roleId: string | null; highestPosition: number; permissions: string; administrator: boolean };
  /** Channels currently used as a Dreamliner log channel. */
  logChannelIds: string[];
};

export function kindOf(type: ChannelType): SnapKind {
  switch (type) {
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildForum:
    case ChannelType.GuildMedia:
      return "forum";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildStageVoice:
      return "stage";
    default:
      return "other";
  }
}

function snapChannel(channel: GuildBasedChannel): SnapChannel | null {
  if (channel.isThread()) return null;
  const c = channel as GuildBasedChannel & {
    topic?: string | null;
    nsfw?: boolean;
    rateLimitPerUser?: number;
    bitrate?: number;
    userLimit?: number;
    lastMessageId?: string | null;
    rawPosition?: number;
    permissionOverwrites?: { cache: Map<string, { id: string; type: OverwriteType; allow: { bitfield: bigint }; deny: { bitfield: bigint } }> };
  };
  return {
    id: channel.id,
    name: channel.name,
    kind: kindOf(channel.type),
    rawType: channel.type,
    parentId: channel.parentId ?? null,
    position: c.rawPosition ?? 0,
    topic: c.topic ?? "",
    nsfw: Boolean(c.nsfw),
    slowmode: c.rateLimitPerUser ?? 0,
    bitrate: c.bitrate ?? 0,
    userLimit: c.userLimit ?? 0,
    hasMessages: Boolean(c.lastMessageId),
    overwrites: [...(c.permissionOverwrites?.cache.values() ?? [])].map((o) => ({
      id: o.id,
      type: o.type === OverwriteType.Member ? "member" : "role",
      allow: o.allow.bitfield.toString(),
      deny: o.deny.bitfield.toString(),
    })),
  };
}

/** Snapshot of the live guild (from the gateway cache; call `guild.channels.fetch()` first for freshness). */
export function snapshotGuild(guild: Guild, logChannelIds: string[] = []): GuildSnapshot {
  const me = guild.members.me;
  const channels = [...guild.channels.cache.values()].map(snapChannel).filter((c): c is SnapChannel => c !== null);
  const roles = [...guild.roles.cache.values()].map((role) => ({
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.position,
    managed: role.managed,
    isEveryone: role.id === guild.id,
    isBooster: Boolean(role.tags?.premiumSubscriberRole),
    members: role.members.size,
  }));
  const botPerms = me?.permissions.bitfield ?? 0n;
  return {
    id: guild.id,
    name: guild.name,
    ownerId: guild.ownerId,
    community: guild.features.includes("COMMUNITY"),
    rulesChannelId: guild.rulesChannelId,
    publicUpdatesChannelId: guild.publicUpdatesChannelId,
    systemChannelId: guild.systemChannelId,
    safetyAlertsChannelId: guild.safetyAlertsChannelId ?? null,
    channels,
    roles,
    bot: {
      userId: me?.id ?? guild.client.user.id,
      roleId: me?.roles.botRole?.id ?? null,
      highestPosition: me?.roles.highest.position ?? 0,
      permissions: botPerms.toString(),
      administrator: (botPerms & PermissionFlagsBits.Administrator) !== 0n,
    },
    logChannelIds: [...new Set(logChannelIds.filter(Boolean))],
  };
}

/** Channels Discord or Dreamliner depends on: never deleted or modified by Autopilot. */
export function protectedChannelIds(snap: GuildSnapshot, options: { includeLogs?: boolean } = {}): Set<string> {
  const ids = [snap.rulesChannelId, snap.publicUpdatesChannelId, snap.systemChannelId, snap.safetyAlertsChannelId];
  if (options.includeLogs !== false) ids.push(...snap.logChannelIds);
  return new Set(ids.filter((id): id is string => Boolean(id)));
}

/** Whether Autopilot may edit or delete this role at all. */
export function roleEditable(snap: GuildSnapshot, role: SnapRole): boolean {
  return !role.isEveryone && !role.managed && !role.isBooster && role.id !== snap.bot.roleId && role.position < snap.bot.highestPosition;
}

/** The SAStructure the dashboard shows for a snapshot (or a backup, which has the same shape). */
export function structureOf(snap: Pick<GuildSnapshot, "channels" | "roles" | "bot"> & Partial<Pick<GuildSnapshot, "rulesChannelId" | "publicUpdatesChannelId" | "systemChannelId" | "safetyAlertsChannelId" | "logChannelIds">>): SAStructure {
  const protectedIds = new Set(
    [snap.rulesChannelId, snap.publicUpdatesChannelId, snap.systemChannelId, snap.safetyAlertsChannelId].filter((id): id is string => Boolean(id)),
  );
  const toExisting = (c: SnapChannel) => ({
    id: c.id,
    name: c.name,
    type: (c.kind === "category" ? "other" : c.kind) as SAExistingChannelType,
    position: c.position,
    topic: c.topic,
    protected: protectedIds.has(c.id),
  });
  const sorted = [...snap.channels].sort((a, b) => sortRank(a) - sortRank(b) || a.position - b.position || a.id.localeCompare(b.id));
  const categories = sorted.filter((c) => c.kind === "category");
  const categoryIds = new Set(categories.map((c) => c.id));
  return {
    categories: categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      position: cat.position,
      channels: sorted.filter((c) => c.parentId === cat.id && c.kind !== "category").map(toExisting),
    })),
    uncategorized: sorted.filter((c) => c.kind !== "category" && (!c.parentId || !categoryIds.has(c.parentId))).map(toExisting),
    roles: [...snap.roles]
      .filter((r) => !r.isEveryone)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        position: r.position,
        managed: r.managed,
        editable: !r.managed && !r.isBooster && r.id !== snap.bot.roleId && r.position < snap.bot.highestPosition,
        members: r.members,
      })),
  };
}

/** Discord sorts text-like channels above voice-like ones inside a category. */
function sortRank(c: SnapChannel): number {
  return c.kind === "voice" || c.kind === "stage" ? 1 : 0;
}
