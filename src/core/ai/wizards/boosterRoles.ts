import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
  entityList,
  idRef,
  int,
  nullable,
  obj,
  oneOf,
  progressInstruction,
  str,
  turnSchemaWithIds,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";

const MAX_QUESTIONS = 4;
/** Most tiers one Autopilot run proposes. */
export const MAX_BOOSTER_TIERS_PER_RUN = 10;

export function boosterRolesConfigSchema(): Record<string, unknown> {
  return obj({
    stacking: nullable(bool()),
    tiers: {
      type: "array",
      items: obj({
        role_id: idRef("role"),
        requirement: oneOf(["duration", "boosts"]),
        duration_days: int(),
        boost_count: nullable(int()),
        name: nullable(str()),
        enabled: nullable(bool()),
      }),
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateBoosterRolesConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const raw = Array.isArray(config.tiers) ? config.tiers.filter(isObject) : [];
  const roleIds = new Set(ctx.roles.map((r) => r.id));
  // One tier per role: the same role twice in one result means the later entry wins.
  const byRole = new Map<string, Record<string, unknown>>();
  for (const t of raw) {
    if (typeof t.role_id !== "string" || !roleIds.has(t.role_id)) continue;
    const requirement = t.requirement === "boosts" ? "boosts" : "duration";
    byRole.set(t.role_id, {
      role_id: t.role_id,
      requirement,
      duration_days: requirement === "duration" ? (clampInt(t.duration_days, 0, 3650) ?? 0) : 0,
      boost_count: requirement === "boosts" ? (clampInt(t.boost_count, 1, 100) ?? 2) : null,
      name: typeof t.name === "string" ? t.name.trim().slice(0, 80) : null,
      enabled: typeof t.enabled === "boolean" ? t.enabled : null,
    });
  }
  config.tiers = [...byRole.values()].slice(0, MAX_BOOSTER_TIERS_PER_RUN);
  if (typeof config.stacking !== "boolean") config.stacking = null;
  if ((config.tiers as unknown[]).length === 0 && config.stacking === null) {
    return "Autopilot didn't pick a real role for this tier. Please try again.";
  }
  return null;
}

export const boosterRolesWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  buildResultSchema: (ctx) => turnSchemaWithIds(boosterRolesConfigSchema(), ctx),
  validateConfig: validateBoosterRolesConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Booster Roles: Dreamliner automatically gives " +
    "boosters role \"tiers\", earned either by how long they have been boosting (requirement " +
    "\"duration\", for example a role at 30 days, a fancier one at 90 days) or by how many boosts " +
    "they have given the server (requirement \"boosts\", for example a role for 2 boosts). You are " +
    "setting this up for " +
    `the server "${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention ` +
    "field names, JSON, or config, ask like a helpful person would. Find out which tiers they want " +
    `(one or several, up to ${MAX_BOOSTER_TIERS_PER_RUN} in one go): for each, which role it grants ` +
    "and what earns it: for a duration tier, how many days of continuous boosting are needed first " +
    "(duration_days, 0 means as soon as they start boosting, max 3650, boost_count null); for a " +
    "boost-count tier, how many boosts the member must have given (boost_count, 1 to 100, " +
    "duration_days 0). Plus an optional short label (max 80 characters) and whether it starts " +
    "switched on (enabled, null = on). Also, only if it comes up or is unclear, whether a member who " +
    "reaches a higher tier keeps every earlier tier's role too (stacking true) or only ever has " +
    "their single highest tier's role of each kind (stacking false); stacking is one server-wide setting, null " +
    "keeps the current choice. A tier for a role that already has one updates that tier. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting roles (pick role_id from these ids only; never pick a role that sounds like a " +
    "bot/managed role, e.g. named after a bot, or @everyone):\n" +
    `${entityList(ctx.roles)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of the choices you " +
    "made (leave question null). Every role_id needs a real id from the list above, never invent one.",
};
