/**
 * Autopilot wizard for Autoreactions: adds one or more rules per run, each with every per-rule
 * setting zAutoreactionsConfig supports (matching, every Nth, cooldown, attachment/link filters).
 */
import { resolveEmojiByName } from "../../emoji.js";
import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  emojiList,
  entityList,
  obj,
  progressInstruction,
  str,
  turnSchemaWithIds,
  type AiWizardDefinition,
} from "../wizardKit.js";
import {
  AUTO_RULE_PROMPT_NOTES,
  MAX_RULES_PER_RUN,
  autoRuleMatchFields,
  sanitizeAutoRuleMatch,
  sanitizeRuleList,
} from "./autoRuleKit.js";

const MAX_QUESTIONS = 4;

function autoreactionRuleSchema(): Record<string, unknown> {
  return obj({ ...autoRuleMatchFields(), emoji: str() });
}

export const autoreactionsWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2500,
  buildResultSchema: (ctx) =>
    turnSchemaWithIds(obj({ rules: { type: "array", items: autoreactionRuleSchema() } }), ctx),
  validateConfig: (config, ctx) =>
    sanitizeRuleList(config, "autoreaction rule", (rule) => {
      const matchProblem = sanitizeAutoRuleMatch(rule, ctx);
      if (matchProblem) return matchProblem;
      const emoji = typeof rule.emoji === "string" ? resolveEmojiByName(rule.emoji, ctx.emojis) : "";
      if (!emoji) return "no emoji to react with";
      rule.emoji = emoji;
      return null;
    }),
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Autoreactions: Dreamliner automatically reacts " +
    "to a message with an emoji when it matches a rule. You are setting this up for the server " +
    `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field ` +
    "names, JSON, or config, ask like a helpful person would. For each rule find out which channel " +
    "it watches (or all channels), what triggers it (every message, or messages containing, " +
    "starting with, or exactly matching a word or phrase, or a regex for power users), and which " +
    "emoji to react with. A rule can also only react on every Nth match, have a cooldown, or only " +
    "react to messages with attachments or links. " +
    `You can return several rules at once (up to ${MAX_RULES_PER_RUN}), for example when the user ` +
    "wants several emoji on the same messages or is importing a MEE6 or Dyno setup; one rule per " +
    "emoji. Never tell the user one of these options is unsupported.\n\n" +
    AUTO_RULE_PROMPT_NOTES +
    "\n\n" +
    NULL_MEANS_UNCHANGED_RULE +
    " For a new rule, null means the default (off). " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting text channels (channel_id must be one of these ids, or \"\" for all channels):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    `This server's custom emoji: ${emojiList(ctx.emojis)}. If the user means one of these (even ` +
    "just by saying its name, like \"blahaj\"), put its exact name with no colons in emoji and " +
    "Dreamliner will use the real custom emoji. Otherwise use a literal Unicode emoji character " +
    "matching what they describe. Never invent a custom emoji name that isn't in that list.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with config.rules holding every rule to add and a short, friendly plain-language " +
    "summary of what you set up (leave question null). emoji always needs a real value.",
};
