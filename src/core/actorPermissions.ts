/**
 * Actor permissions: the one place that decides whether the PERSON asking Dreamliner to do
 * something (a dashboard user or a command invoker) could do it themselves in Discord.
 *
 * Dreamliner's own permissions are high, so anything it does for a member must be limited to what
 * that member holds. The dashboard gate (Manage Server / `memberCanManage` / `can_manage`) only
 * decides who may USE a page; it never grants more than the member has. The rules mirror Discord:
 *
 * - Channels, categories and permission overwrites need Manage Channels (overwrites also Manage
 *   Roles), and an overwrite can't allow or deny a permission the member lacks.
 * - Roles need Manage Roles, must sit below the member's highest role, and can't carry permissions
 *   the member lacks. The same goes for giving or taking a role from members.
 * - The guild owner passes everything. Administrator passes every permission check but not the
 *   role hierarchy. Platform superusers (dashboard staff) are treated like the owner.
 *
 * Pure checks take an `ActorInfo`; the async helpers resolve it from the live guild and deny when
 * the member can't be found.
 */
import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";
import { isDashboardSuperuser } from "../bridge/superuser.js";

export type PermName = keyof typeof PermissionFlagsBits;

export type ActorInfo = {
  userId: string;
  /** The guild owner: passes every check, including the role hierarchy. */
  owner: boolean;
  /** Has Administrator: passes every permission check, not the role hierarchy. */
  administrator: boolean;
  /** A Dreamliner platform superuser: treated like the owner. */
  superuser: boolean;
  /** Guild-level permission bitfield. */
  permissions: bigint;
  /** Position of the member's highest role (0 = only @everyone). */
  highestPosition: number;
};

/** The minimum a role check needs (a discord.js Role or a snapshot of one). */
export type ActorRoleTarget = { id: string; name: string; position: number; managed: boolean; permissions: bigint };

const LABELS: Partial<Record<PermName, string>> = {
  Administrator: "Administrator",
  ManageGuild: "Manage Server",
  ManageChannels: "Manage Channels",
  ManageRoles: "Manage Roles",
  ManageWebhooks: "Manage Webhooks",
  ManageGuildExpressions: "Manage Expressions",
  ManageMessages: "Manage Messages",
  ManageNicknames: "Manage Nicknames",
  ManageThreads: "Manage Threads",
  ManageEvents: "Manage Events",
  KickMembers: "Kick Members",
  BanMembers: "Ban Members",
  ModerateMembers: "Timeout Members",
  MentionEveryone: "Mention Everyone",
  ViewAuditLog: "View Audit Log",
  MoveMembers: "Move Members",
  MuteMembers: "Mute Members",
  DeafenMembers: "Deafen Members",
  ViewChannel: "View Channels",
  SendMessages: "Send Messages",
};

/** "ManageRoles" → "Manage Roles" (falls back to splitting the camel case). */
export function permissionLabel(name: string): string {
  return LABELS[name as PermName] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Names of the permission bits set in `value`, as labels. */
export function permissionLabels(value: bigint): string[] {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(PermissionFlagsBits) as Array<[PermName, bigint]>) {
    if ((value & bit) !== 0n && !names.includes(permissionLabel(name))) names.push(permissionLabel(name));
  }
  return names;
}

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export type ActorErrorCode = "actor_unresolved" | "missing_permissions" | "role_hierarchy";

/**
 * A refusal the bridge turns into a 403. `toJson()` is the site's usual error shape
 * (`{ error }`) plus the details for inline UI.
 */
export class ActorPermissionError extends Error {
  readonly status = 403;
  constructor(
    message: string,
    readonly code: ActorErrorCode,
    readonly missing: string[] = [],
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ActorPermissionError";
  }

  toJson(): { error: string; code: ActorErrorCode; missing: string[]; problems: string[] } {
    return { error: this.message, code: this.code, missing: this.missing, problems: this.problems };
  }
}

export const ACTOR_UNRESOLVED_MESSAGE = "Dreamliner couldn't confirm your permissions in this server. Make sure you're still a member, then try again.";

// ── Pure checks ─────────────────────────────────────────────────────────────

const ALL_PERMISSIONS = Object.values(PermissionFlagsBits).reduce((acc, bit) => acc | bit, 0n);

/** Owner, superuser or Administrator: every permission check passes. */
export function actorHasAllPermissions(actor: ActorInfo): boolean {
  return actor.owner || actor.superuser || actor.administrator;
}

/** Owner or superuser: the role hierarchy doesn't apply. */
export function actorAboveHierarchy(actor: ActorInfo): boolean {
  return actor.owner || actor.superuser;
}

export function actorHas(actor: ActorInfo, flag: bigint): boolean {
  return actorHasAllPermissions(actor) || (actor.permissions & flag) === flag;
}

/** The permissions in `names` the actor lacks. */
export function missingActorPermissions(actor: ActorInfo, names: readonly PermName[]): PermName[] {
  return names.filter((name) => !actorHas(actor, PermissionFlagsBits[name]));
}

/** Every bit the actor may hand to a role or overwrite. */
export function actorGrantablePermissions(actor: ActorInfo): bigint {
  return actorHasAllPermissions(actor) ? ALL_PERMISSIONS : actor.permissions;
}

/** Whether the role sits low enough for the actor to edit, delete or hand out. */
export function actorOutranksPosition(actor: ActorInfo, position: number): boolean {
  return actorAboveHierarchy(actor) || position < actor.highestPosition;
}

/**
 * Why the actor may not create, edit, give or take this role, or null when they may. Mirrors what
 * Discord enforces for a real member: Manage Roles, strictly below their highest role, and only
 * permissions they already have. Managed roles and @everyone can never be handed out.
 */
export function actorRoleProblem(actor: ActorInfo, role: ActorRoleTarget, guildId: string): string | null {
  if (role.id === guildId) return "@everyone can't be given or taken.";
  if (role.managed) return `@${role.name} is managed by an integration, so it can't be given or taken.`;
  if (!actorHas(actor, PermissionFlagsBits.ManageRoles)) return `You need Manage Roles to use @${role.name}.`;
  if (!actorOutranksPosition(actor, role.position)) return `@${role.name} is at or above your highest role.`;
  const lacking = role.permissions & ~actorGrantablePermissions(actor);
  if (lacking !== 0n) {
    const names = permissionLabels(lacking);
    return `@${role.name} has ${names.length === 1 ? "a permission" : "permissions"} you don't have (${joinList(names.slice(0, 4))}${names.length > 4 ? "…" : ""}).`;
  }
  return null;
}

/** The standard "you need X to Y" sentence. */
export function missingPermissionMessage(missing: readonly string[], action: string): string {
  const labels = missing.map(permissionLabel);
  return `You need ${joinList(labels)} to ${action}. Ask someone with ${labels.length === 1 ? "that permission" : "those permissions"}.`;
}

// ── Live guild ──────────────────────────────────────────────────────────────

export function actorFromMember(member: GuildMember): ActorInfo {
  const owner = member.id === member.guild.ownerId;
  const permissions = member.permissions.bitfield;
  return {
    userId: member.id,
    owner,
    administrator: (permissions & PermissionFlagsBits.Administrator) !== 0n,
    superuser: isDashboardSuperuser(member.id),
    permissions,
    highestPosition: member.roles.highest?.position ?? 0,
  };
}

/** A platform superuser who isn't (or can't be found) in the guild. */
function superuserActor(userId: string): ActorInfo {
  return { userId, owner: false, administrator: true, superuser: true, permissions: ALL_PERMISSIONS, highestPosition: Number.MAX_SAFE_INTEGER };
}

/**
 * The actor as they are in the guild right now, or null when they aren't a member (deny). Fetches
 * the member when they aren't cached so permissions come from live roles.
 */
export async function resolveActor(guild: Guild, actorId: string | null | undefined): Promise<ActorInfo | null> {
  if (!actorId || !/^\d{15,25}$/.test(actorId)) return null;
  let member: GuildMember | null = guild.members.cache.get(actorId) ?? null;
  if (!member) member = await guild.members.fetch(actorId).catch(() => null);
  if (member) return actorFromMember(member);
  if (isDashboardSuperuser(actorId)) return superuserActor(actorId);
  return null;
}

/** resolveActor, throwing the standard refusal when the member can't be found. */
export async function requireActor(guild: Guild, actorId: string | null | undefined): Promise<ActorInfo> {
  const actor = await resolveActor(guild, actorId);
  if (!actor) throw new ActorPermissionError(ACTOR_UNRESOLVED_MESSAGE, "actor_unresolved");
  return actor;
}

/**
 * Throws an ActorPermissionError naming every missing permission, e.g. "You need Manage Channels
 * to create ticket channels." Returns the actor when they have them all.
 */
export async function requireActorPermissions(guild: Guild, actorId: string | null | undefined, perms: readonly PermName[], action: string): Promise<ActorInfo> {
  const actor = await requireActor(guild, actorId);
  const missing = missingActorPermissions(actor, perms);
  if (missing.length) throw new ActorPermissionError(missingPermissionMessage(missing, action), "missing_permissions", missing.map(permissionLabel));
  return actor;
}

function roleTarget(role: Role): ActorRoleTarget {
  return { id: role.id, name: role.name, position: role.position, managed: role.managed, permissions: role.permissions.bitfield };
}

/** Whether the actor may create, edit, give or take this role (see actorRoleProblem). */
export async function canActorManageRole(guild: Guild, actorId: string | null | undefined, roleOrId: Role | string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const actor = await resolveActor(guild, actorId);
  if (!actor) return { ok: false, reason: ACTOR_UNRESOLVED_MESSAGE };
  const role = typeof roleOrId === "string" ? guild.roles.cache.get(roleOrId) : roleOrId;
  if (!role) return { ok: false, reason: "That role doesn't exist in this server." };
  const problem = actorRoleProblem(actor, roleTarget(role), guild.id);
  return problem ? { ok: false, reason: problem } : { ok: true };
}

/** Problems for each role id the actor may not hand out (from the guild cache). */
export function grantableRoleProblems(guild: Guild, actor: ActorInfo, roleIds: Iterable<string>): string[] {
  const problems: string[] = [];
  for (const id of new Set(roleIds)) {
    const role = guild.roles.cache.get(id);
    if (!role) {
      problems.push(`Role ${id} isn't a role in this server.`);
      continue;
    }
    const problem = actorRoleProblem(actor, roleTarget(role), guild.id);
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * Throws when any of these roles is one the actor couldn't give themselves (for settings that make
 * Dreamliner give or take roles: rewards, autoroles, panels, rank roles and so on).
 */
export async function assertGrantableRoles(guild: Guild, actorId: string | null | undefined, roleIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(roleIds)].filter(Boolean);
  if (!ids.length) return;
  const actor = await requireActor(guild, actorId);
  const problems = grantableRoleProblems(guild, actor, ids);
  if (!problems.length) return;
  throw new ActorPermissionError(grantableRolesMessage(problems), "role_hierarchy", [], problems);
}

/** One readable sentence for a list of role problems. */
export function grantableRolesMessage(problems: string[]): string {
  const head = problems.length === 1 ? problems[0]! : `${problems[0]} (and ${problems.length - 1} more)`;
  return `${head} ${GRANT_HINT}`;
}

/**
 * The config-save check (ConfigManager.setRoleGrantGuard): newly added roles in grantable fields
 * must be ones the saver could give themselves, and newly added channels the bot creates channels
 * in or renames need the saver's Manage Channels. Returns readable problems, empty when allowed.
 */
export function createRoleGrantGuard(client: { guilds: { cache: Map<string, Guild> } }): (guildId: string, actorId: string, added: { roleIds: string[]; channelIds: string[] }) => Promise<string[]> {
  return async (guildId, actorId, added) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return [ACTOR_UNRESOLVED_MESSAGE];
    const actor = await resolveActor(guild, actorId);
    if (!actor) return [ACTOR_UNRESOLVED_MESSAGE];
    const problems: string[] = [];
    if (added.channelIds.length && !actorHas(actor, PermissionFlagsBits.ManageChannels)) {
      problems.push(missingPermissionMessage(["ManageChannels"], "point counters, temporary rooms or tickets at a channel or category (Dreamliner creates or renames channels there)"));
    }
    const roleProblems = grantableRoleProblems(guild, actor, added.roleIds);
    if (roleProblems.length) problems.push(...roleProblems, GRANT_HINT);
    return problems;
  };
}

export const GRANT_HINT = "Dreamliner can only give or take roles you could give yourself: you need Manage Roles, the role must be below your highest role, and it can't have permissions you don't have.";
