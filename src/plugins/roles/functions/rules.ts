import type { GuildMember } from "discord.js";
import type { RoleRule } from "../../../config/schemas/roleRules.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("roles");

/** Rules can trigger each other (A + B → C, then C → D), so a member's roles are worked out over
 *  a few passes until nothing more changes. */
const MAX_PASSES = 5;

export type RoleRulePlan =
  | { status: "ok"; add: string[]; remove: string[]; rules: string[] }
  /** Rules that undo each other (A → B, B → A): nothing is applied. */
  | { status: "loop"; rules: string[] };

function ruleLabel(rule: RoleRule, index: number): string {
  return rule.name.trim() || `Rule ${index + 1}`;
}

/** What one rule would change for a member with these roles, or null when it doesn't apply or
 *  would change nothing (so the bot's own role edits never re-trigger it). */
function applyRule(rule: RoleRule, held: Set<string>): { add: string[]; remove: string[] } | null {
  if (!rule.enabled || rule.if_roles.length === 0) return null;
  const matched = rule.if_roles.filter((id) => held.has(id));
  const triggers = rule.match === "all" ? matched.length === rule.if_roles.length : matched.length > 0;
  if (!triggers || rule.unless_roles.some((id) => held.has(id))) return null;

  const remove = new Set(rule.remove_roles.filter((id) => held.has(id)));
  if (rule.remove_matched) for (const id of matched) remove.add(id);
  const add = rule.give_roles.filter((id) => !held.has(id) && !remove.has(id));
  if (add.length === 0 && remove.size === 0) return null;
  return { add, remove: [...remove] };
}

/**
 * Works out every rule against a member's roles. Pure (no Discord), so it's easy to test: the
 * result is the overall difference between the roles they have and the roles they should have.
 */
export function planRoleRules(rules: RoleRule[], roleIds: Iterable<string>): RoleRulePlan {
  const start = new Set(roleIds);
  const held = new Set(start);
  const fired: string[] = [];
  const seen = new Set<string>([[...held].sort().join(",")]);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    rules.forEach((rule, index) => {
      const change = applyRule(rule, held);
      if (!change) return;
      for (const id of change.remove) held.delete(id);
      for (const id of change.add) held.add(id);
      fired.push(ruleLabel(rule, index));
      changed = true;
    });
    if (!changed) {
      return {
        status: "ok",
        add: [...held].filter((id) => !start.has(id)),
        remove: [...start].filter((id) => !held.has(id)),
        rules: [...new Set(fired)],
      };
    }
    const state = [...held].sort().join(",");
    if (seen.has(state)) return { status: "loop", rules: [...new Set(fired)] };
    seen.add(state);
  }
  return { status: "loop", rules: [...new Set(fired)] };
}

/** Members being updated right now: the role change the bot makes comes straight back as another
 *  member update, which is skipped while the first is still applying. */
const inFlight = new Set<string>();

/** Runs a server's rules for one member and applies the result. Roles the bot can't manage
 *  (above its own highest role, or managed by an integration) are left alone. */
export async function applyRoleRules(member: GuildMember, rules: RoleRule[]): Promise<void> {
  if (member.user.bot || rules.length === 0) return;
  const key = `${member.guild.id}:${member.id}`;
  if (inFlight.has(key)) return;

  const plan = planRoleRules(rules, member.roles.cache.keys());
  if (plan.status === "loop") {
    log.warn(`[role rules] ${member.guild.id}: rules undo each other (${plan.rules.join(", ")}), skipped for ${member.id}`);
    return;
  }
  const manageable = (id: string) => {
    const role = member.guild.roles.cache.get(id);
    return Boolean(role && role.editable && !role.managed && role.id !== member.guild.id);
  };
  const add = plan.add.filter(manageable);
  const remove = plan.remove.filter(manageable);
  if (add.length === 0 && remove.length === 0) return;

  const reason = `Role rule: ${plan.rules.join(", ")}`.slice(0, 500);
  inFlight.add(key);
  try {
    if (remove.length > 0) await member.roles.remove(remove, reason);
    if (add.length > 0) await member.roles.add(add, reason);
  } catch (error) {
    log.warn(`[role rules] ${member.guild.id}: couldn't update ${member.id}:`, error);
  } finally {
    inFlight.delete(key);
  }
}
