/**
 * Settings whose roles Dreamliner gives to (or takes from) members on its own: autoroles, rewards,
 * role panels, rank roles, verified roles and so on. Whoever saves one of these must be able to
 * give that role themselves (Manage Roles, below their highest role, no permissions they lack),
 * otherwise a Manage Server-only manager could make the bot hand out roles above them. The check
 * runs on every config save (ConfigManager.saveGuildConfig), for newly added ids only, so configs
 * that were already saved keep working.
 *
 * Exported in `schema/guild-config.meta.json` (`grantableRoleFields`) so the dashboard can mark
 * these role pickers.
 *
 * Paths are `<plugin>.<path inside plugins.<plugin>.config>`; `*` stands for any key or index.
 * A leaf may be a role id, a list of role ids, or autorole-style `{ role }` entries.
 */
export const GRANTABLE_ROLE_FIELDS = [
  // autorole/functions/applyRoles.ts
  "autorole.roles",
  "autorole.bot_roles",
  // activity_rewards/functions/rewards.ts
  "activity_rewards.milestones.*.roles",
  "activity_rewards.milestones.*.remove_roles",
  // booster_roles/functions/apply.ts
  "booster_roles.tiers.*.role_id",
  // birthdays/functions/celebrate.ts
  "birthdays.role.role_id",
  // role_panels/functions/handlers.ts
  "role_panels.panels.*.roles.*.role_id",
  // roles/functions/rules.ts (if-then rules)
  "roles.rules.*.give_roles",
  "roles.rules.*.remove_roles",
  // passport/functions/roles.ts
  "passport.unverified_role_id",
  "passport.grant_role_ids",
  "passport.remove_role_ids",
  // applications/functions/review.ts
  "applications.openings.*.accept_roles",
  "applications.openings.*.accept_remove_roles",
  // suggestions/functions/service.ts
  "suggestions.approved_role",
  "suggestions.implemented_role",
  // team_control (ranks, duty, leave, suspension)
  "team_control.ranks.*.role_id",
  "team_control.shifts.duty_role_id",
  "team_control.leave.loa_role_id",
  "team_control.leave.ra_role_id",
  "team_control.actions.suspended_role_id",
  // companion_channels: role given while in a temporary room
  "companion_channels.join_role_id",
] as const;

export type GrantableRoleField = (typeof GRANTABLE_ROLE_FIELDS)[number];

const SNOWFLAKE = /^\d{15,25}$/;

function leafIds(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (SNOWFLAKE.test(value.trim())) out.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) leafIds(item, out);
    return;
  }
  // autorole entries: { role, delay_ms }
  if (value && typeof value === "object" && typeof (value as { role?: unknown }).role === "string") leafIds((value as { role: string }).role, out);
}

function walk(value: unknown, parts: string[], out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (!parts.length) {
    leafIds(value, out);
    return;
  }
  const [head, ...rest] = parts;
  if (head === "*") {
    const children = Array.isArray(value) ? value : typeof value === "object" ? Object.values(value as Record<string, unknown>) : [];
    for (const child of children) walk(child, rest, out);
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) return;
  walk((value as Record<string, unknown>)[head!], rest, out);
}

/** Every role id a config (merged or user overrides) has in a grantable field. */
export function collectGrantableRoleIds(config: unknown): Set<string> {
  const out = new Set<string>();
  const plugins = config && typeof config === "object" ? (config as { plugins?: Record<string, { config?: unknown }> }).plugins : undefined;
  if (!plugins || typeof plugins !== "object") return out;
  for (const field of GRANTABLE_ROLE_FIELDS) {
    const [plugin, ...path] = field.split(".");
    walk(plugins[plugin!]?.config, path, out);
  }
  return out;
}

/** Grantable role ids in `next` that weren't in `previous` (only these are checked on save). */
export function addedGrantableRoleIds(previous: unknown, next: unknown): string[] {
  const before = collectGrantableRoleIds(previous);
  return [...collectGrantableRoleIds(next)].filter((id) => !before.has(id));
}

/**
 * The actor a config save is made for, from its `updatedBy`: a plain Discord id (dashboard saves,
 * commands) or a system save made on someone's behalf (Server Autopilot, snapshot rollback).
 * Null for genuinely automatic saves, which aren't checked.
 */
export function actorFromUpdatedBy(updatedBy: string): string | null {
  const plain = /^(\d{15,25})$/.exec(updatedBy);
  if (plain) return plain[1]!;
  const behalf = /^system:(?:server-autopilot|snapshot-rollback):(\d{15,25})$/.exec(updatedBy);
  return behalf ? behalf[1]! : null;
}
