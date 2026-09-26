/**
 * Autopilot wizard for Member Identity: remember a member's nickname, roles and timeout when
 * they leave and reapply them when they rejoin. Every setting is nullable (null = unchanged).
 */
import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
  entityList,
  idArray,
  int,
  keepIds,
  nullable,
  obj,
  progressInstruction,
  turnSchemaWithIds,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";

const MAX_QUESTIONS = 4;
/** zMemberIdentityConfig.delay_ms max is 300000 ms. */
export const MEMBER_IDENTITY_MAX_DELAY_SECONDS = 300;

const BOOL_FIELDS = [
  "save_on_leave",
  "save_on_update",
  "restore_nickname",
  "restore_roles",
  "restore_timeout",
  "skip_managed_roles",
  "ignore_bots",
] as const;

export function buildMemberIdentityResultSchema(ctx: AiWizardContext): Record<string, unknown> {
  const props: Record<string, Record<string, unknown>> = {};
  for (const key of BOOL_FIELDS) props[key] = nullable(bool());
  props.ignored_roles = nullable(idArray("role"));
  props.delay_seconds = nullable(int());
  return turnSchemaWithIds(obj(props), ctx);
}

export function validateMemberIdentityConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  for (const key of BOOL_FIELDS) {
    if (typeof config[key] !== "boolean") config[key] = null;
  }
  config.ignored_roles = keepIds(config.ignored_roles, ctx, "role");
  config.delay_seconds = clampInt(config.delay_seconds, 0, MEMBER_IDENTITY_MAX_DELAY_SECONDS);
  return null;
}

function buildMemberIdentityPrompt(ctx: AiWizardContext, questionsAsked: number): string {
  return (
    "You are helping a Discord server admin set up Member Identity: when a member leaves, " +
    "Dreamliner remembers their nickname, roles, and any active timeout, and can reapply them if " +
    "that member rejoins later, so they pick up where they left off instead of starting over " +
    "(restoring roles only ever adds roles back, it never removes anything). You are setting " +
    `this up for the server "${ctx.guildName}". Ask ONE short, plain-language question at a ` +
    "time. Never mention field names, JSON, or config, ask like a helpful person would.\n\n" +
    "What it can do:\n" +
    "- Save a snapshot when a member leaves (save_on_leave), and keep it current whenever their " +
    "nickname, roles or timeout change (save_on_update, recommended so restores stay accurate).\n" +
    "- Restore the nickname, the roles, and a still-running timeout on rejoin (the timeout needs " +
    "Moderate Members and is off by default since it's a stricter choice).\n" +
    "- Skip roles Discord manages (bot, booster and integration roles), on by default.\n" +
    "- Ignore bot accounts entirely, on by default.\n" +
    "- Never restore certain roles (ignored_roles), for example a muted or staff role. Roles you " +
    "list are added to the existing ignore list.\n" +
    "- Wait up to 300 seconds after the rejoin before restoring (delay_seconds), for example so " +
    "autorole or verification runs first.\n\n" +
    "Focus on: should the nickname come back, should roles come back, and should an active " +
    "timeout come back. Only bring up the rest if the user mentions it or it clearly matters. " +
    NULL_MEANS_UNCHANGED_RULE +
    " Leave anything the user didn't mention null, even when you would pick the default. " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting roles (ignored_roles must come from these ids only, never invent one):\n" +
    `${entityList(ctx.roles)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of the changes " +
    "(leave question null)."
  );
}

export const memberIdentityWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  buildResultSchema: buildMemberIdentityResultSchema,
  validateConfig: validateMemberIdentityConfig,
  buildSystemPrompt: buildMemberIdentityPrompt,
};
