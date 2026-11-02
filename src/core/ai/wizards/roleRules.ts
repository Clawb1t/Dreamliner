/**
 * Autopilot wizard for the Roles plugin's if-then role rules (plugins.roles.config.rules). The
 * admin describes rules in plain words and the dashboard merges them into the existing list: a
 * rule with the same name as an existing one edits it, anything else is added (up to the limit).
 * Granting stays as safe as the runtime makes it: applyRoleRules only gives roles that pass
 * autoGrantableRoleIds (no staff, managed or above-the-bot roles), whatever a rule says.
 */
import { MAX_ROLE_RULES, MAX_RULE_ROLES } from "../../../config/schemas/roleRules.js";
import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  entityList,
  idArray,
  keepIds,
  nullable,
  obj,
  oneOf,
  progressInstruction,
  str,
  turnSchemaWithIds,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { MAX_RULES_PER_RUN, isRow } from "./autoRuleKit.js";

const MAX_QUESTIONS = 5;
const MAX_RULE_NAME = 80;
const RULE_MATCHES = ["all", "any"] as const;

function ruleSchema(): Record<string, unknown> {
  return obj({
    name: str(),
    enabled: nullable(bool()),
    match: nullable(oneOf(RULE_MATCHES)),
    if_roles: nullable(idArray("role")),
    unless_roles: nullable(idArray("role")),
    give_roles: nullable(idArray("role")),
    remove_roles: nullable(idArray("role")),
    remove_matched: nullable(bool()),
  });
}

export function roleRulesConfigSchema(): Record<string, unknown> {
  return obj({ rules: { type: "array", items: ruleSchema() } });
}

function roleList(value: unknown, ctx: AiWizardContext): string[] | null {
  return keepIds(value, ctx, "role")?.slice(0, MAX_RULE_ROLES) ?? null;
}

export function validateRoleRulesConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const raw = Array.isArray(config.rules) ? config.rules.filter(isRow) : [];
  // The same name twice in one result: the later entry wins (it edits the same rule).
  const byName = new Map<string, Record<string, unknown>>();
  const unnamed: Record<string, unknown>[] = [];
  for (const r of raw) {
    const name = typeof r.name === "string" ? r.name.trim().slice(0, MAX_RULE_NAME) : "";
    const rule = {
      name,
      enabled: typeof r.enabled === "boolean" ? r.enabled : null,
      match: typeof r.match === "string" && (RULE_MATCHES as readonly string[]).includes(r.match) ? r.match : null,
      if_roles: roleList(r.if_roles, ctx),
      unless_roles: roleList(r.unless_roles, ctx),
      give_roles: roleList(r.give_roles, ctx),
      remove_roles: roleList(r.remove_roles, ctx),
      remove_matched: typeof r.remove_matched === "boolean" ? r.remove_matched : null,
    };
    // Without a name it can only be a new rule, and a new rule needs roles to look for.
    if (!name && !rule.if_roles?.length) continue;
    if (name) byName.set(name.toLowerCase(), rule);
    else unnamed.push(rule);
  }
  const rules = [...byName.values(), ...unnamed].slice(0, Math.min(MAX_RULES_PER_RUN, MAX_ROLE_RULES));
  if (raw.length > 0 && rules.length === 0) return "Autopilot didn't pick real roles for any rule. Please try again.";
  config.rules = rules;
  return null;
}

export const roleRulesWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 3000,
  buildResultSchema: (ctx) => turnSchemaWithIds(roleRulesConfigSchema(), ctx),
  validateConfig: validateRoleRulesConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up role rules: if-then rules that run whenever a " +
    "member's roles change. When a member has certain roles, Dreamliner gives them other roles and " +
    "takes some away, for example \"when someone gets Verified, give Member and remove Unverified\", or " +
    "\"members with both Artist and Writer get Creator instead\". Rules can lead into each other, and " +
    `rules that undo each other are skipped. You are setting this up for "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config. " +
    "Find out what should happen and match the roles by name from the list below; ask which role is " +
    "meant when it's unclear, and never invent roles that don't exist. When the admin describes the rules " +
    "clearly up front, go straight to \"ready\". Server boosting is a role too: \"when a member boosts\" " +
    "means having the server's booster role (usually named \"Server Booster\" or \"Nitro Booster\"), so use " +
    "it in if_roles. Never give staff, moderator, admin or bot roles with a rule (Dreamliner refuses to give " +
    "roles with moderation or admin permissions anyway); rules are for member roles. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nEach rule:\n" +
    `- name: a short label (max ${MAX_RULE_NAME} characters, e.g. \"Verified to Member\"). A rule with the same ` +
    "name as one the server already has EDITS that rule: only its non-null fields change. Otherwise it is " +
    `added as a new rule (at most ${MAX_ROLE_RULES} rules per server, ${MAX_RULES_PER_RUN} per run).\n` +
    "- if_roles: the roles the rule looks for (required for a new rule).\n" +
    "- match: \"all\" (the member needs every if_roles role, the default) or \"any\" (one is enough).\n" +
    "- unless_roles: members with any of these are skipped.\n" +
    "- give_roles: roles given when the rule triggers.\n" +
    "- remove_roles: roles taken away when the rule triggers.\n" +
    "- remove_matched: also take away the if_roles roles that triggered it (e.g. A + B become C).\n" +
    "- enabled: false turns a rule off without deleting it.\n" +
    `Each role list holds at most ${MAX_RULE_ROLES} roles. For a new rule, null fields get the defaults ` +
    "(on, match all, empty lists, remove_matched false). Inside a rule that edits an existing one, set every " +
    "field the user didn't mention to null, never [] (that would clear it). Leave rules as an empty list " +
    "if the user doesn't want any changes.\n\n" +
    "Existing roles (pick roles from these ids only):\n" +
    `${entityList(ctx.roles)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of the rules (leave " +
    "question null). Never invent ids.",
};
