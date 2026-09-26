/**
 * Autopilot wizard for Autorole. One run can add several roles for humans and/or bots, each with
 * its own delay. The dashboard adds them to the existing lists (a role already in a list just gets
 * its delay updated), so nothing already configured is removed.
 */
import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  clampInt,
  entityList,
  idRef,
  int,
  nullable,
  obj,
  progressInstruction,
  turnSchemaWithIds,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";

const MAX_QUESTIONS = 4;
/** Delays run on an in-process timer, so keep them short (a day at most). */
export const AUTOROLE_MAX_DELAY_SECONDS = 86_400;

function roleEntryList(): Record<string, unknown> {
  return nullable({ type: "array", items: obj({ role_id: idRef("role"), delay_seconds: int() }) });
}

export function buildAutoroleResultSchema(ctx: AiWizardContext): Record<string, unknown> {
  return turnSchemaWithIds(obj({ roles: roleEntryList(), bot_roles: roleEntryList() }), ctx);
}

type Entry = { role_id: string; delay_seconds: number };

function sanitizeEntries(raw: unknown, ctx: AiWizardContext): Entry[] | null {
  if (!Array.isArray(raw)) return null;
  const known = new Set(ctx.roles.map((r) => r.id));
  const byRole = new Map<string, Entry>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { role_id, delay_seconds } = item as Record<string, unknown>;
    if (typeof role_id !== "string" || !known.has(role_id)) continue;
    byRole.set(role_id, { role_id, delay_seconds: clampInt(delay_seconds, 0, AUTOROLE_MAX_DELAY_SECONDS) ?? 0 });
  }
  return byRole.size ? [...byRole.values()] : null;
}

export function validateAutoroleConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  config.roles = sanitizeEntries(config.roles, ctx);
  config.bot_roles = sanitizeEntries(config.bot_roles, ctx);
  if (!config.roles && !config.bot_roles) {
    return "Autopilot didn't pick a real role to grant. Please try again.";
  }
  return null;
}

function buildAutorolePrompt(ctx: AiWizardContext, questionsAsked: number): string {
  return (
    "You are helping a Discord server admin set up Autorole: Dreamliner automatically gives " +
    "roles to new members when they join. There are two separate lists: roles for humans (roles) " +
    "and roles for bots (bot_roles). Each role can be granted right away or after a delay (for " +
    "example to let a verification step or another bot finish first), up to one day. You can add " +
    `several roles to either list, or both, in one go. You are setting this up for the server "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config, " +
    "ask like a helpful person would. Find out which role(s) to give, whether they are for people " +
    "or bots joining, and whether to wait before giving them. Roles you return are added to the " +
    "existing lists (a role that is already there just gets the new delay); nothing is removed. " +
    NULL_MEANS_UNCHANGED_RULE +
    " Set a list to null when nothing is added to it; at least one list must have a role. " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting roles (role_id must come from these ids only; never pick a role that sounds like " +
    "a bot/managed role, e.g. named after a bot, for humans, and never invent an id):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "delay_seconds is 0 for immediately, otherwise how many seconds to wait (convert an answer " +
    "like \"5 minutes\" to 300 yourself), at most 86400.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of the roles being " +
    "added (leave question null)."
  );
}

export const autoroleWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  buildResultSchema: buildAutoroleResultSchema,
  validateConfig: validateAutoroleConfig,
  buildSystemPrompt: buildAutorolePrompt,
};
