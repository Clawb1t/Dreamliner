/**
 * Server Autopilot permissions: role presets, the allow-list of permissions a template may ask
 * for, and the channel access → permission overwrite mapping. Pure (bigint maths only).
 */
import { PermissionFlagsBits } from "discord.js";
import { STAFF_PRESETS, type SAAccess, type SACapability, type SAChannelType, type SAPermRule, type SARole, type SARolePreset } from "./types.js";

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

  applyMuted(list, ctx);
  if (hidden) list.push({ target: { kind: "bot" }, allow: BOT_ALLOW, deny: 0n });
  return list;
}

function applyMuted(list: PlannedOverwrite[], ctx: OverwriteContext): void {
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
}

/** How hidden an access level is: a channel is never more visible than its category. */
const VISIBILITY_RANK: Record<SAAccess, number> = { everyone: 0, read_only: 0, roles: 0, verified_only: 1, hidden_roles: 2, staff_only: 3 };
const POSTING_LIMITS: ReadonlySet<SAAccess> = new Set<SAAccess>(["read_only", "roles"]);

export type AccessSpec = { access: SAAccess; roleKeys: readonly string[] };

/**
 * The overwrites for a channel whose access differs from its category's. Discord doesn't layer a
 * category under its channels (an unsynced channel only has its own overwrites), so the
 * category's rules are folded in here:
 * - who can SEE it comes from whichever of the two is more hidden (a "read only" channel in a
 *   staff-only category stays staff-only);
 * - who can POST comes from the channel when it limits posting, otherwise from a read-only
 *   category (staff_only / hidden_roles lists already name their posters).
 * A channel that just inherits (access everyone) should use the category's overwrites as they are.
 */
export function channelAccessOverwrites(channel: AccessSpec, category: AccessSpec | null, ctx: OverwriteContext): PlannedOverwrite[] {
  if (!category) return accessOverwrites(channel.access, channel.roleKeys, ctx);
  const visFromCategory = VISIBILITY_RANK[category.access] > VISIBILITY_RANK[channel.access];
  const visibility = visFromCategory ? category : channel;
  const list = accessOverwrites(visibility.access, visibility.roleKeys, ctx);
  let posting: AccessSpec | null = null;
  if (POSTING_LIMITS.has(channel.access)) posting = channel;
  else if (visibility.access !== "staff_only" && visibility.access !== "hidden_roles" && POSTING_LIMITS.has(category.access)) posting = category;
  if (posting && posting !== visibility) restrictPosting(list, posting.roleKeys, ctx);
  return list.filter((o) => o.allow !== 0n || o.deny !== 0n);
}

/** Only staff and `roleKeys` may post / connect; everyone else keeps whatever view they had. */
function restrictPosting(list: PlannedOverwrite[], roleKeys: readonly string[], ctx: OverwriteContext): void {
  const write = ctx.voice ? CONNECT : SEND;
  const writers = new Set([...staffKeys(ctx), ...roleKeys]);
  for (const o of list) {
    if (o.target.kind === "role" && !writers.has(o.target.key)) o.allow &= ~write;
  }
  const everyone = list.find((o) => o.target.kind === "everyone");
  if (everyone) {
    everyone.deny |= write;
    everyone.allow &= ~write;
  } else {
    list.unshift({ target: { kind: "everyone" }, allow: 0n, deny: write });
  }
  for (const key of writers) addAllow(list, key, write);
  applyMuted(list, ctx);
}

function targetId(target: OverwriteTarget): string {
  return target.kind === "role" ? `role:${target.key}` : target.kind;
}

/** Whether two planned overwrite lists are the same set (what Discord calls "synced"). */
export function samePlannedOverwrites(a: readonly PlannedOverwrite[], b: readonly PlannedOverwrite[]): boolean {
  const sig = (list: readonly PlannedOverwrite[]) =>
    list
      .filter((o) => o.allow !== 0n || o.deny !== 0n)
      .map((o) => `${targetId(o.target)}:${o.allow}:${o.deny}`)
      .sort()
      .join("|");
  return sig(a) === sig(b);
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

// ── AI permission rules ─────────────────────────────────────────────────────

/** The Discord permission bits behind each rule capability. */
export const CAPABILITY_BITS: Record<SACapability, bigint> = {
  view: bit("ViewChannel"),
  chat: bits(["SendMessages", "SendMessagesInThreads", "SendVoiceMessages"]),
  threads: bits(["CreatePublicThreads", "CreatePrivateThreads"]),
  react: bit("AddReactions"),
  files: bit("AttachFiles"),
  embeds: bit("EmbedLinks"),
  history: bit("ReadMessageHistory"),
  polls: bit("SendPolls"),
  external_emoji: bits(["UseExternalEmojis", "UseExternalStickers"]),
  commands: bits(["UseApplicationCommands", "UseExternalApps"]),
  connect: bit("Connect"),
  speak: bits(["Speak", "UseVAD"]),
  video: bit("Stream"),
  soundboard: bits(["UseSoundboard", "UseExternalSounds"]),
  moderate: bits(["ManageMessages", "ManageThreads", "PinMessages", "MuteMembers", "DeafenMembers", "MoveMembers", "BypassSlowmode"]),
  ping_everyone: bit("MentionEveryone"),
};
/** Capabilities only staff roles may be granted. */
const STAFF_CAPABILITY_BITS = CAPABILITY_BITS.moderate | CAPABILITY_BITS.ping_everyone;

function capabilityBits(caps: readonly SACapability[]): bigint {
  return caps.reduce((acc, cap) => acc | (CAPABILITY_BITS[cap] ?? 0n), 0n);
}

const cloneList = (list: readonly PlannedOverwrite[]): PlannedOverwrite[] => list.map((o) => ({ target: { ...o.target }, allow: o.allow, deny: o.deny }) as PlannedOverwrite);

/** Layers rules over a list: a rule's allows and denies win over what the list had for that target. */
export function applyPermRules(list: PlannedOverwrite[], rules: readonly SAPermRule[], ctx: OverwriteContext): void {
  const known = new Set(ctx.roles.map((r) => r.key));
  const staff = new Set(staffKeys(ctx));
  for (const rule of rules) {
    if (rule.target !== "everyone" && !known.has(rule.target)) continue;
    const deny = capabilityBits(rule.deny);
    let allow = capabilityBits(rule.allow) & ~deny;
    if (!staff.has(rule.target)) allow &= ~STAFF_CAPABILITY_BITS;
    if (!allow && !deny) continue;
    const target: OverwriteTarget = rule.target === "everyone" ? { kind: "everyone" } : { kind: "role", key: rule.target };
    let entry = list.find((o) => targetId(o.target) === targetId(target));
    if (!entry) {
      entry = { target, allow: 0n, deny: 0n };
      list.push(entry);
    }
    entry.allow = (entry.allow & ~deny) | allow;
    entry.deny = (entry.deny & ~allow) | deny;
  }
}

function hidesFromEveryone(list: readonly PlannedOverwrite[]): boolean {
  const everyone = list.find((o) => o.target.kind === "everyone");
  return Boolean(everyone && everyone.deny & VIEW);
}

/**
 * The safety pass after rules: rules may tighten anything but can't open a channel up.
 * - For every `ceiling` (the access level's own list, the category) that hides the channel from
 *   @everyone, the result hides it too and only roles that ceiling lets in (or staff) may see it.
 * - Moderation / @everyone pings never go to @everyone or member roles; muted stays muted.
 * - Whenever @everyone can't see it, the bot keeps access.
 */
export function guardOverwrites(list: PlannedOverwrite[], ctx: OverwriteContext, ceilings: ReadonlyArray<readonly PlannedOverwrite[]>): PlannedOverwrite[] {
  const staff = new Set(staffKeys(ctx));
  for (const ceiling of ceilings) {
    if (!hidesFromEveryone(ceiling)) continue;
    const viewers = new Set(staff);
    for (const o of ceiling) if (o.target.kind === "role" && o.allow & VIEW) viewers.add(o.target.key);
    let everyone = list.find((o) => o.target.kind === "everyone");
    if (!everyone) {
      everyone = { target: { kind: "everyone" }, allow: 0n, deny: 0n };
      list.unshift(everyone);
    }
    everyone.deny |= VIEW;
    everyone.allow &= ~VIEW;
    for (const o of list) if (o.target.kind === "role" && !viewers.has(o.target.key)) o.allow &= ~VIEW;
  }
  for (const o of list) {
    if (o.target.kind === "everyone" || (o.target.kind === "role" && !staff.has(o.target.key))) o.allow &= ~STAFF_CAPABILITY_BITS;
  }
  applyMuted(list, ctx);
  if (hidesFromEveryone(list)) {
    const bot = list.find((o) => o.target.kind === "bot");
    if (bot) bot.allow |= BOT_ALLOW;
    else list.push({ target: { kind: "bot" }, allow: BOT_ALLOW, deny: 0n });
  }
  return list.filter((o) => o.allow !== 0n || o.deny !== 0n);
}

export type PermItem = AccessSpec & { rules: readonly SAPermRule[] };

/** A category's overwrites: its access level, then its rules, then the safety pass. */
export function planCategoryOverwrites(category: PermItem, roles: OverwriteContext["roles"]): PlannedOverwrite[] {
  const ctx: OverwriteContext = { roles, voice: false, category: true };
  const base = accessOverwrites(category.access, category.roleKeys, ctx);
  const list = cloneList(base);
  applyPermRules(list, category.rules, ctx);
  return guardOverwrites(list, ctx, [base]);
}

/** Whether a channel just follows its category (no access or rules of its own). */
export function inheritsCategory(channel: PermItem): boolean {
  return channel.access === "everyone" && channel.roleKeys.length === 0 && channel.rules.length === 0;
}

/**
 * A channel's overwrites. One that inherits gets its category's exactly (synced); otherwise the
 * category's access and rules are folded in (Discord doesn't layer them for an unsynced
 * channel), then the channel's own rules, then the safety pass against both the channel's
 * access and the category's final overwrites.
 */
export function planChannelOverwrites(
  channel: PermItem,
  category: (PermItem & { planned: readonly PlannedOverwrite[] }) | null,
  roles: OverwriteContext["roles"],
  voice: boolean,
): PlannedOverwrite[] {
  if (category && inheritsCategory(channel)) return cloneList(category.planned);
  const ctx: OverwriteContext = { roles, voice };
  const base = channelAccessOverwrites(channel, category, ctx);
  const list = cloneList(base);
  if (category) applyPermRules(list, category.rules, ctx);
  applyPermRules(list, channel.rules, ctx);
  return guardOverwrites(list, ctx, category ? [base, category.planned] : [base]);
}
