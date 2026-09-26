/**
 * Autopilot wizard for Autoreplies: adds one or more rules per run, each with every per-rule
 * setting zAutorepliesConfig supports (matching, filters, text, embed, link buttons, webhook
 * identity, delivery flags).
 */
import {
  ANSWER_KIND_RULE,
  COLOR_RULE,
  FULL_PLACEHOLDER_NOTE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  emojiList,
  entityList,
  nullable,
  obj,
  progressInstruction,
  str,
  turnSchemaWithIds,
  type AiWizardDefinition,
} from "../wizardKit.js";
import {
  AUTO_RULE_PROMPT_NOTES,
  MAX_RULES_PER_RUN,
  RICH_MESSAGE_PROMPT_NOTES,
  autoRuleMatchFields,
  boolOrNull,
  hasEmbedOrButtons,
  richMessageFields,
  sanitizeAutoRuleMatch,
  sanitizeRichMessage,
  sanitizeRuleList,
} from "./autoRuleKit.js";

const MAX_QUESTIONS = 5;

function autoreplyRuleSchema(): Record<string, unknown> {
  return obj({
    ...autoRuleMatchFields(),
    response: str(),
    reply_to_message: nullable(bool()),
    ...richMessageFields(),
  });
}

export const autorepliesWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 4000,
  buildResultSchema: (ctx) =>
    turnSchemaWithIds(obj({ rules: { type: "array", items: autoreplyRuleSchema() } }), ctx),
  validateConfig: (config, ctx) =>
    sanitizeRuleList(config, "autoreply rule", (rule) => {
      const matchProblem = sanitizeAutoRuleMatch(rule, ctx);
      if (matchProblem) return matchProblem;
      rule.response = typeof rule.response === "string" ? rule.response.slice(0, 2000) : "";
      rule.reply_to_message = boolOrNull(rule.reply_to_message);
      sanitizeRichMessage(rule, ctx);
      if (!(rule.response as string).trim() && !hasEmbedOrButtons(rule)) return "no reply text, embed, or buttons";
      return null;
    }),
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Autoreplies: when a message matches a rule, " +
    "Dreamliner automatically answers with a message. You are setting this up for the server " +
    `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field ` +
    "names, JSON, or config, ask like a helpful person would. For each rule find out which channel " +
    "it watches (or all channels), what triggers it (every message, or messages containing, " +
    "starting with, or exactly matching a word or phrase, or a regex for power users), and what " +
    "the reply says. When you write a reply, make it warm and specific to what was asked, never " +
    "generic filler.\n\n" +
    "Everything a rule can do: reply to the triggering message or post a standalone message " +
    "(reply_to_message, default true, ignored for webhooks), only fire on every Nth match, a " +
    "cooldown, only react to messages with attachments or links, and a rich reply (text, embed, " +
    "link buttons, webhook name and avatar, silent, no link previews, ping controls). " +
    `You can return several rules at once (up to ${MAX_RULES_PER_RUN}), for example when the user ` +
    "lists many triggers or is importing a MEE6 or Dyno autoresponder list; one rule per trigger. " +
    "Never tell the user one of these options is unsupported.\n\n" +
    AUTO_RULE_PROMPT_NOTES +
    "\n\n" +
    RICH_MESSAGE_PROMPT_NOTES +
    " response can be \"\" only when the rule has an enabled embed or buttons. " +
    COLOR_RULE +
    "\n\n" +
    FULL_PLACEHOLDER_NOTE +
    "\n\n" +
    NULL_MEANS_UNCHANGED_RULE +
    " For a new rule, null means the default. " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting text channels (channel_id must be one of these ids, or \"\" for all channels):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    `This server's custom emoji (for button emoji, use the exact name without colons, or a Unicode emoji): ${emojiList(ctx.emojis)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with config.rules holding every rule to add and a short, friendly plain-language " +
    "summary of what you set up (leave question null).",
};
