/**
 * "Builder's perms, capped": a command can only do what the person who saved it could do
 * themselves. On save, the saver must hold every permission the steps need and outrank every
 * role the steps give, take or edit; the command stores them as last_editor_id. On every run the
 * same check runs again against that person as they are now (still a member, still holding the
 * permissions), and Dreamliner's own permissions and hierarchy are checked too.
 *
 * Every picked id must belong to this guild: checkGuildIds refuses ids that aren't one of its
 * roles/channels (another server's ids, deleted ones), on save and before each run.
 */
import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import {
  actorRoleProblem,
  missingActorPermissions,
  permissionLabel,
  type ActorInfo,
  type PermName,
} from "../../../core/actorPermissions.js";
import { CONDITION_MAP } from "./conditions.js";
import { SNOWFLAKE_RE, type CatalogField } from "./fields.js";
import { ACTION_MAP } from "./registry.js";
import { channelKindName } from "./runtime.js";
import type { CommandProgram, Condition, MessageSpec, Step } from "./types.js";
import { walkSteps, type Issue } from "./validate.js";

export type StepRequirement = {
  stepId: string;
  type: string;
  builder: PermName[];
  bot: PermName[];
  runner: PermName[];
  /** Picked roles the step gives, takes or edits. */
  grantRoles: string[];
  plugin: string | null;
};

export type Requirements = {
  steps: StepRequirement[];
  builder: PermName[];
  bot: PermName[];
  plugins: Map<string, string[]>;
};

function messageSpecs(config: Record<string, unknown>): MessageSpec[] {
  const spec = config.message as MessageSpec | undefined;
  return spec && typeof spec === "object" && spec.pings ? [spec] : [];
}

export function collectRequirements(program: CommandProgram): Requirements {
  const steps: StepRequirement[] = [];
  const plugins = new Map<string, string[]>();
  walkSteps(program.steps, (step) => {
    if (step.disabled) return;
    const def = ACTION_MAP.get(step.type);
    if (!def) return;
    const config = step.config as Record<string, unknown>;
    const builder = new Set<PermName>(def.builderPerms?.(config) ?? []);
    const bot = new Set<PermName>(def.botPerms?.(config) ?? []);
    for (const spec of messageSpecs(config)) {
      if (spec.pings.everyone || spec.pings.roles.length) {
        builder.add("MentionEveryone");
        bot.add("MentionEveryone");
      }
    }
    const grantRoles: string[] = [];
    for (const key of def.grantRoleKeys ?? []) {
      const v = config[key];
      if (typeof v === "string" && SNOWFLAKE_RE.test(v.trim())) grantRoles.push(v.trim());
    }
    if (def.plugin) plugins.set(def.plugin, [...(plugins.get(def.plugin) ?? []), step.id]);
    steps.push({ stepId: step.id, type: step.type, builder: [...builder], bot: [...bot], runner: def.runnerPerms?.(config) ?? [], grantRoles, plugin: def.plugin ?? null });
  });
  const union = (k: "builder" | "bot") => [...new Set(steps.flatMap((s) => s[k]))];
  return { steps, builder: union("builder"), bot: union("bot"), plugins };
}

export type PermissionReport = { missing: string[]; problems: { stepId: string | null; message: string }[] };

/** What the saver (or, at run time, the last editor) lacks. Empty = allowed. */
export function builderReport(guild: Guild, actor: ActorInfo, req: Requirements): PermissionReport {
  const missing = new Set<string>();
  const problems: PermissionReport["problems"] = [];
  for (const step of req.steps) {
    const lacking = missingActorPermissions(actor, step.builder);
    if (lacking.length) {
      lacking.forEach((p) => missing.add(permissionLabel(p)));
      problems.push({ stepId: step.stepId, message: `Needs ${lacking.map(permissionLabel).join(", ")}.` });
    }
    for (const roleId of step.grantRoles) {
      const role = guild.roles.cache.get(roleId);
      if (!role) continue; // reported by checkGuildIds
      const problem = actorRoleProblem(actor, { id: role.id, name: role.name, position: role.position, managed: role.managed, permissions: role.permissions.bitfield }, guild.id);
      if (problem) problems.push({ stepId: step.stepId, message: problem });
    }
  }
  return { missing: [...missing], problems };
}

/** What Dreamliner itself lacks (server-wide permissions and hierarchy for picked roles). */
export function botReport(guild: Guild, req: Requirements): PermissionReport {
  const me = guild.members.me;
  if (!me) return { missing: [], problems: [{ stepId: null, message: "Dreamliner couldn't load its own member." }] };
  const missing = new Set<string>();
  const problems: PermissionReport["problems"] = [];
  for (const step of req.steps) {
    const lacking = step.bot.filter((p) => !me.permissions.has(PermissionFlagsBits[p]));
    if (lacking.length) {
      lacking.forEach((p) => missing.add(permissionLabel(p)));
      problems.push({ stepId: step.stepId, message: `Dreamliner needs ${lacking.map(permissionLabel).join(", ")}.` });
    }
    for (const roleId of step.grantRoles) {
      const role = guild.roles.cache.get(roleId);
      if (role && role.position >= me.roles.highest.position) problems.push({ stepId: step.stepId, message: `@${role.name} is above Dreamliner's highest role.` });
    }
  }
  return { missing: [...missing], problems };
}

// ── Guild id checks ─────────────────────────────────────────────────────────────────────────

function channelTypeOk(type: ChannelType, wanted: string[] | undefined, allowCategories: boolean): boolean {
  const kind = channelKindName(type);
  if (kind === "category") return allowCategories || Boolean(wanted?.includes("category"));
  if (!wanted?.length) return true;
  return wanted.includes(kind);
}

function checkFieldIds(guild: Guild, fields: CatalogField[], config: Record<string, unknown>, at: (field: string, message: string) => void): void {
  for (const field of fields) {
    const value = config[field.key];
    const ids: string[] =
      typeof value === "string" ? (SNOWFLAKE_RE.test(value.trim()) ? [value.trim()] : []) : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && SNOWFLAKE_RE.test(v)) : [];
    if (!ids.length) continue;
    if (field.kind === "role" || field.kind === "roles" || field.kind === "role_target") {
      for (const id of ids) {
        if (!guild.roles.cache.has(id)) at(field.key, "That role isn't in this server (it may have been deleted). Pick it again.");
        else if (id === guild.id && field.kind !== "roles") at(field.key, "@everyone can't be used here.");
      }
    }
    if (field.kind === "channel" || field.kind === "channels" || field.kind === "channel_target") {
      for (const id of ids) {
        const channel = guild.channels.cache.get(id);
        if (!channel) at(field.key, "That channel isn't in this server (it may have been deleted). Pick it again.");
        else if (!channelTypeOk(channel.type, field.channelTypes, Boolean(field.allowCategories))) at(field.key, `#${channel.name} isn't the right kind of channel here.`);
      }
    }
  }
}

/** Issues for every picked id that isn't one of this guild's roles or channels. */
export function checkGuildIds(guild: Guild, program: CommandProgram): Issue[] {
  const issues: Issue[] = [];
  const access = program.access;
  for (const key of ["roles", "blockedRoles"] as const) {
    if (access[key].some((id) => !guild.roles.cache.has(id))) issues.push({ path: `access.${key}`, stepId: null, message: "A role here isn't in this server any more. Remove it or pick again." });
  }
  for (const key of ["channels", "blockedChannels"] as const) {
    if (access[key].some((id) => !guild.channels.cache.has(id))) issues.push({ path: `access.${key}`, stepId: null, message: "A channel here isn't in this server any more. Remove it or pick again." });
  }
  walkSteps(program.steps, (step: Step) => {
    const def = ACTION_MAP.get(step.type);
    if (!def) return;
    const config = step.config as Record<string, unknown>;
    const at = (field: string, message: string) => issues.push({ path: `steps.${step.id}.config.${field}`, stepId: step.id, message });
    checkFieldIds(guild, def.fields, config, at);
    for (const spec of messageSpecs(config)) {
      if (spec.pings.roles.some((id) => !guild.roles.cache.has(id) || id === guild.id)) at("message", "A role allowed to be pinged isn't in this server.");
    }
    if (step.type === "if") {
      const branches = (config.branches as { conditions: Condition[] }[]) ?? [];
      branches.forEach((b, bi) =>
        b.conditions.forEach((c, ci) => {
          const cdef = CONDITION_MAP.get(c.type);
          if (cdef) checkFieldIds(guild, cdef.fields, c as Record<string, unknown>, (f, m) => issues.push({ path: `steps.${step.id}.config.branches.${bi}.conditions.${ci}.${f}`, stepId: step.id, message: m }));
        }),
      );
    }
  });
  return issues;
}

/** Discord's default_member_permissions bitfield for the command list, or null for everyone. */
export function visibilityBits(program: CommandProgram): string | null {
  let bits = 0n;
  for (const name of program.access.visibility) {
    const bit = PermissionFlagsBits[name as PermName];
    if (bit) bits |= bit;
  }
  return bits ? bits.toString() : null;
}
