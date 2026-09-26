/**
 * Autopilot wizard for Autodelete: adds (or updates) one or more channel rules per run with every
 * setting zAutodeleteRule supports. A channel that already has a rule gets it updated on the
 * dashboard (null keeps the current value) rather than a duplicate.
 */
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
  progressInstruction,
  str,
  turnSchemaWithIds,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { MAX_RULES_PER_RUN, boolOrNull, isRow, strOrNull } from "./autoRuleKit.js";

const MAX_QUESTIONS = 4;

function autodeleteRuleSchema(): Record<string, unknown> {
  return obj({
    channel_id: idRef("text_channel"),
    delay_seconds: nullable(int()),
    name: nullable(str()),
    enabled: nullable(bool()),
  });
}

export const autodeleteWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2500,
  requiresEntity: {
    kind: "textChannels",
    message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) =>
    turnSchemaWithIds(obj({ rules: { type: "array", items: autodeleteRuleSchema() } }), ctx),
  validateConfig: (config, ctx) => {
    const known = new Set(ctx.textChannels.map((c) => c.id));
    const byChannel = new Map<string, Record<string, unknown>>();
    const raw = Array.isArray(config.rules) ? config.rules.filter(isRow) : [];
    for (const rule of raw.slice(0, MAX_RULES_PER_RUN)) {
      if (typeof rule.channel_id !== "string" || !known.has(rule.channel_id)) continue;
      // One rule per channel: a later entry for the same channel wins.
      byChannel.set(rule.channel_id, {
        channel_id: rule.channel_id,
        delay_seconds: clampInt(rule.delay_seconds, 1, 604_800),
        name: strOrNull(rule.name, 80),
        enabled: boolOrNull(rule.enabled),
      });
    }
    config.rules = [...byChannel.values()];
    if (byChannel.size === 0) return "Autopilot picked a channel that doesn't exist. Please try again.";
    return null;
  },
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Autodelete: Dreamliner automatically deletes " +
    "every message posted in a chosen channel after a delay (common uses: a bot-command channel, " +
    "a giveaway-entry channel, anywhere that shouldn't build up a permanent history). You are " +
    `setting this up for the server "${ctx.guildName}". Ask ONE short, plain-language question at ` +
    "a time. Never mention field names, JSON, or config, ask like a helpful person would. Find " +
    "out which channel, and how long to wait before deleting (a few seconds, a minute, an hour, " +
    "a day, up to a week maximum).\n\n" +
    "Each rule is one channel with: delay_seconds (1 to 604800, that is up to 7 days; always set " +
    "it when you know it, null keeps an existing rule's delay or uses 60 for a new one), an " +
    "optional short dashboard label (name, max 80 characters), and enabled (on or off without " +
    `deleting the rule). You can return several rules at once (up to ${MAX_RULES_PER_RUN}), one ` +
    "per channel, for example when importing a Dyno Auto Delete or Auto Purge list. If a channel " +
    "already has a rule, this result updates it. Never tell the user one of these options is " +
    "unsupported.\n\n" +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting text channels (channel_id must be one of these ids):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with config.rules holding every channel rule and a short, friendly plain-language " +
    "summary of what you set up (leave question null).",
};
