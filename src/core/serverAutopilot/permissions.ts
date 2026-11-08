/**
 * Server Autopilot permissions: role presets, the allow-list of permissions a template may ask
 * for, and the channel access → permission overwrite mapping. Pure (bigint maths only).
 */
import { PermissionFlagsBits } from "discord.js";
import { STAFF_PRESETS, type SAAccess, type SAChannelType, type SARole, type SARolePreset } from "./types.js";

type PermName = keyof typeof PermissionFlagsBits;
const bit = (name: PermName): bigint => PermissionFlagsBits[name];
const bits = (names: readonly PermName[]): bigint => names.reduce((acc, name) => acc | bit(name), 0n);

/** Everyday permissions any role may get as an extra. */
export const SAFE_PERMISSIONS = [
  "ViewChannel", "SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads", "EmbedLinks",
  "AttachFiles", "AddReactions", "UseExternalEmojis", "UseExternalStickers", "ReadMessageHistory", "UseApplicationCommands",
  "Connect", "Speak", "Stream", "UseVAD", "UseSoundboard", "UseExternalSounds", "ChangeNickname", "CreateInstantInvite",
  "RequestToSpeak", "UseEmbeddedActivities", "SendVoiceMessages", "SendPolls", "UseExternalApps",
] as const satisfies readonly PermName[];

/** Moderation and management permissions: only staff presets may carry these. */
export const STAFF_ONLY_PERMISSIONS = [
  "KickMembers", "BanMembers", "ModerateMembers", "ManageMessages", "ManageThreads", "ManageNicknames", "MuteMembers",
  "DeafenMembers", "MoveMembers", "ManageChannels", "ManageRoles", "ManageWebhooks", "ManageGuildExpressions", "ManageEvents",
  "CreateEvents", "CreateGuildExpressions", "ViewAuditLog", "ViewGuildInsights", "MentionEveryone", "PrioritySpeaker",
  "PinMessages", "BypassSlowmode", "SetVoiceChannelStatus",
] as const satisfies readonly PermName[];

/** Every permission name a template's `extra_permissions` may use (Administrator and Manage
 *  Server are never on it; Manage Server only comes with the owner preset). */
export const PERMISSION_FLAGS: readonly string[] = [...SAFE_PERMISSIONS, ...STAFF_ONLY_PERMISSIONS];

const SAFE_SET = new Set<string>(SAFE_PERMISSIONS);
const STAFF_SET = new Set<string>(STAFF_ONLY_PERMISSIONS);

const MOD_PERMS: PermName[] = [
  "ManageMessages", "ManageThreads", "ModerateMembers", "KickMembers", "ManageNicknames", "MuteMembers", "DeafenMembers",
  "MoveMembers", "ViewAuditLog", "PinMessages", "BypassSlowmode",
];
const ADMIN_PERMS: PermName[] = [
  ...MOD_PERMS, "BanMembers", "ManageChannels", "ManageRoles", "ManageWebhooks", "ManageGuildExpressions", "ManageEvents",
  "CreateEvents", "CreateGuildExpressions", "MentionEveryone", "ViewGuildInsights", "PrioritySpeaker", "SetVoiceChannelStatus",
];

/** Base role permissions per preset. Members get their everyday permissions from @everyone, so
 *  member-tier presets add nothing; staff presets stack up. No preset ever has Administrator. */
export const PERMISSION_PRESETS: Record<SARolePreset, bigint> = {
  owner: bits([...ADMIN_PERMS, "ManageGuild"]),
  admin: bits(ADMIN_PERMS),
  moderator: bits(MOD_PERMS),
  staff: bits(["ManageMessages", "ManageThreads", "ModerateMembers", "MoveMembers", "PinMessages"]),
  helper: bits(["ManageMessages", "ManageThreads", "PinMessages"]),
  member: 0n,
  verified: 0n,
  vip: bits(["UseExternalStickers", "UseExternalEmojis"]),
  booster_like: bits(["UseExternalStickers", "UseExternalEmojis"]),
  muted: 0n,
  cosmetic: 0n,
  ping: 0n,
  bot: 0n,
};

/** Never granted by Autopilot, whatever the bot has. */
export const NEVER_GRANT = bit("Administrator");

export function isStaffPreset(preset: SARolePreset): boolean {
  return STAFF_PRESETS.has(preset);
}

/** Filters a template's extra permission names down to the allow-list for this preset. */
export function allowedExtraPermissions(preset: SARolePreset, names: readonly string[]): string[] {
  const staff = isStaffPreset(preset);
  const out: string[] = [];
  for (const name of names) {
    if (out.includes(name)) continue;
    if (SAFE_SET.has(name) || (staff && STAFF_SET.has(name))) out.push(name);
  }
  return out;
}

export type RolePermissionResult = { permissions: bigint; dropped: string[] };

/** Names of the permission bits set in `value`. */
export function permissionNames(value: bigint): string[] {
  return (Object.keys(PermissionFlagsBits) as PermName[]).filter((name) => (value & bit(name)) !== 0n);
}

/**
 * The permission bitfield a template role gets: its preset plus allowed extras, never
 * Administrator, and never anything the bot itself lacks (unless the bot is an administrator).
 * `dropped` names what had to be left out because the bot can't grant it.
 */
export function rolePermissions(role: Pick<SARole, "preset" | "extra_permissions">, botPermissions: bigint, botIsAdmin: boolean): RolePermissionResult {
  let wanted = PERMISSION_PRESETS[role.preset];
  for (const name of allowedExtraPermissions(role.preset, role.extra_permissions)) wanted |= bit(name as PermName);
  wanted &= ~NEVER_GRANT;
  if (botIsAdmin) return { permissions: wanted, dropped: [] };
  const granted = wanted & botPermissions;
  return { permissions: granted, dropped: permissionNames(wanted & ~granted) };
}

// ── Channel overwrites ─────────────────────────────────────────────────────

/** Who an overwrite targets, before ids are known: @everyone, a template role, or the bot. */
export type OverwriteTarget = { kind: "everyone" } | { kind: "role"; key: string } | { kind: "bot" };
export type PlannedOverwrite = { target: OverwriteTarget; allow: bigint; deny: bigint };

const SEND = bits(["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads"]);
const VIEW = bit("ViewChannel");
const CONNECT = bits(["Connect", "Speak"]);
const MUTED_DENY = bits(["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads", "AddReactions", "Speak", "SendVoiceMessages", "SendPolls"]);
/** The bot keeps seeing and managing every channel it hides from @everyone. */
const BOT_ALLOW = bits(["ViewChannel", "SendMessages", "ReadMessageHistory", "EmbedLinks", "AttachFiles", "Connect", "ManageMessages"]);

export type OverwriteContext = {
  roles: Array<Pick<SARole, "key" | "preset">>;
  /** Whether the item is a voice/stage channel (Connect instead of Send). */
  voice: boolean;
  /** Categories hold both kinds: allows cover Send and Connect, read-only denies only Send. */
  category?: boolean;
};

function staffKeys(ctx: OverwriteContext): string[] {
  return ctx.roles.filter((r) => isStaffPreset(r.preset)).map((r) => r.key);
}

function verifiedKeys(ctx: OverwriteContext): string[] {
  return ctx.roles.filter((r) => r.preset === "verified" || r.preset === "member").map((r) => r.key);
}

function addAllow(list: PlannedOverwrite[], key: string, allow: bigint): void {
  const existing = list.find((o) => o.target.kind === "role" && o.target.key === key);
  if (existing) existing.allow |= allow;
  else list.push({ target: { kind: "role", key }, allow, deny: 0n });
}

/**
 * The overwrites an access level means for a category or channel:
 * - everyone: nothing (inherit), read_only: @everyone can't post, staff and listed roles can.
 * - staff_only / hidden_roles / verified_only: hidden from @everyone, shown to the right roles.
 * - roles: visible to everyone, only listed (and staff) roles can post / connect.
 * Hidden channels always keep the bot in, and a muted role is denied posting everywhere.
 */
export function accessOverwrites(access: SAAccess, roleKeys: readonly string[], ctx: OverwriteContext): PlannedOverwrite[] {
  const list: PlannedOverwrite[] = [];
  const write = ctx.category ? SEND | CONNECT : ctx.voice ? CONNECT : SEND;
  const denyWrite = ctx.category ? SEND : write;
  const staff = staffKeys(ctx);
  let hidden = false;

  switch (access) {
    case "everyone":
      break;
    case "read_only":
      list.push({ target: { kind: "everyone" }, allow: 0n, deny: denyWrite });
      for (const key of [...staff, ...roleKeys]) addAllow(list, key, write);
      break;
    case "roles":
      list.push({ target: { kind: "everyone" }, allow: 0n, deny: denyWrite });
      for (const key of [...staff, ...roleKeys]) addAllow(list, key, write);
      break;
    case "staff_only":
      hidden = true;
      list.push({ target: { kind: "everyone" }, allow: 0n, deny: VIEW });
      for (const key of [...staff, ...roleKeys]) addAllow(list, key, VIEW | write);
      break;
    case "hidden_roles":
      hidden = true;
      list.push({ target: { kind: "everyone" }, allow: 0n, deny: VIEW });
      for (const key of [...roleKeys, ...staff]) addAllow(list, key, VIEW | write);
      break;
    case "verified_only":
      hidden = true;
      list.push({ target: { kind: "everyone" }, allow: 0n, deny: VIEW });
      for (const key of [...verifiedKeys(ctx), ...roleKeys, ...staff]) addAllow(list, key, VIEW);
      break;
  }

  for (const role of ctx.roles) {
    if (role.preset !== "muted") continue;
    const existing = list.find((o) => o.target.kind === "role" && o.target.key === role.key);
    if (existing) {
      existing.deny |= MUTED_DENY;
      existing.allow &= ~MUTED_DENY;
    } else {
      list.push({ target: { kind: "role", key: role.key }, allow: 0n, deny: MUTED_DENY });
    }
  }

  if (hidden) list.push({ target: { kind: "bot" }, allow: BOT_ALLOW, deny: 0n });
  return list;
}

/** Overwrites the bot can actually set: only bits it has itself (unless it's an administrator). */
export function clampOverwrites(list: PlannedOverwrite[], botPermissions: bigint, botIsAdmin: boolean): PlannedOverwrite[] {
  if (botIsAdmin) return list;
  return list
    .map((o) => ({ ...o, allow: o.allow & botPermissions, deny: o.deny & botPermissions }))
    .filter((o) => o.allow !== 0n || o.deny !== 0n);
}

/** Canonical comparable form of a set of overwrites (sorted, bitfields as strings). */
export function overwriteSignature(list: Array<{ id: string; allow: bigint; deny: bigint }>): string {
  return list
    .filter((o) => o.allow !== 0n || o.deny !== 0n)
    .map((o) => `${o.id}:${o.allow.toString()}:${o.deny.toString()}`)
    .sort()
    .join("|");
}

export function isVoiceType(type: SAChannelType | "category"): boolean {
  return type === "voice" || type === "stage";
}
