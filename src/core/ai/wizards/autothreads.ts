/**
 * Autopilot wizard for Autothreads: adds one or more rules per run, each with every per-rule
 * setting zAutothreadsConfig supports (matching, filters, thread name/archive/slowmode, and the
 * rich message posted inside the new thread).
 */
import {
  ANSWER_KIND_RULE,
  COLOR_RULE,
  FULL_PLACEHOLDER_NOTE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  clampInt,
  emojiList,
  entityList,
  int,
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
  richMessageFields,
  sanitizeAutoRuleMatch,
  sanitizeRichMessage,
  sanitizeRuleList,
  strOrNull,
} from "./autoRuleKit.js";

const MAX_QUESTIONS = 5;
export const THREAD_ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const;

function autothreadRuleSchema(): Record<string, unknown> {
  return obj({
    ...autoRuleMatchFields(),
    thread_name: nullable(str()),
    auto_archive_minutes: nullable({ type: "integer", enum: [...THREAD_ARCHIVE_MINUTES] }),
    thread_slowmode_seconds: nullable(int()),
    response: str(),
    ...richMessageFields(),
  });
}

export const autothreadsWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 4000,
  buildResultSchema: (ctx) =>
    turnSchemaWithIds(obj({ rules: { type: "array", items: autothreadRuleSchema() } }), ctx),
  validateConfig: (config, ctx) =>
    sanitizeRuleList(config, "autothread rule", (rule) => {
      const matchProblem = sanitizeAutoRuleMatch(rule, ctx);
      if (matchProblem) return matchProblem;
      const name = strOrNull(rule.thread_name, 100);
      rule.thread_name = name ? name : null;
      rule.auto_archive_minutes = (THREAD_ARCHIVE_MINUTES as readonly unknown[]).includes(rule.auto_archive_minutes)
        ? rule.auto_archive_minutes
        : null;
      rule.thread_slowmode_seconds = clampInt(rule.thread_slowmode_seconds, 0, 21_600);
      rule.response = typeof rule.response === "string" ? rule.response.slice(0, 2000) : "";
      sanitizeRichMessage(rule, ctx);
      return null;
    }),
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Autothreads: when a message matches a rule, " +
    "Dreamliner starts a thread on it and can post a message inside. You are setting this up for " +
    `the server "${ctx.guildName}". Ask ONE short, plain-language question at a time. Never ` +
    "mention field names, JSON, or config, ask like a helpful person would. For each rule find out " +
    "which channel it watches (or all channels), what triggers a thread (every message, or messages " +
    "containing, starting with, or exactly matching a word or phrase, or a regex for power users), " +
    "how the thread is named, and whether Dreamliner should post anything inside it.\n\n" +
    "Everything a rule can do: a thread name with placeholders (thread_name, max 100 characters, " +
    "default \"{user_display}\"), when the thread auto-archives after going idle " +
    "(auto_archive_minutes: exactly 60, 1440, 4320, or 10080, default 1440), a slowmode inside the " +
    "new thread (thread_slowmode_seconds, 0 to 21600, 0 for none), only fire on every Nth match, a " +
    "cooldown, only messages with attachments or links, and a rich message inside the thread " +
    "(text, embed, link buttons, webhook name and avatar, silent, no link previews, ping controls). " +
    `You can return several rules at once (up to ${MAX_RULES_PER_RUN}), for example when importing ` +
    "a MEE6 or Dyno setup. Never tell the user one of these options is unsupported.\n\n" +
    AUTO_RULE_PROMPT_NOTES +
    "\n\n" +
    RICH_MESSAGE_PROMPT_NOTES +
    " response is \"\" when nothing should be posted as text in the thread. " +
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
