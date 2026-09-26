/**
 * Autopilot wizard for Persist (sticky messages): one sticky per run with every setting
 * zPersistSticky supports. If the channel already has a sticky, the dashboard merges this
 * result onto it (null keeps the current value) instead of adding a shadowed duplicate.
 */
import {
  ANSWER_KIND_RULE,
  COLOR_RULE,
  FULL_PLACEHOLDER_NOTE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
  emojiList,
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
import {
  RICH_MESSAGE_PROMPT_NOTES,
  boolOrNull,
  hasEmbedOrButtons,
  richMessageFields,
  sanitizeRichMessage,
  strOrNull,
} from "./autoRuleKit.js";

const MAX_QUESTIONS = 5;

function persistStickySchema(): Record<string, unknown> {
  return obj({
    channel_id: idRef("text_channel"),
    content: str(),
    name: nullable(str()),
    enabled: nullable(bool()),
    delay_seconds: nullable(int()),
    message_threshold: nullable(int()),
    ...richMessageFields(),
    ignore_bots: nullable(bool()),
    ignore_webhooks: nullable(bool()),
  });
}

export const persistWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 3000,
  requiresEntity: {
    kind: "textChannels",
    message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) => turnSchemaWithIds(persistStickySchema(), ctx),
  validateConfig: (config, ctx) => {
    const channelId = config.channel_id;
    if (typeof channelId !== "string" || !ctx.textChannels.some((c) => c.id === channelId)) {
      return "Autopilot picked a channel that doesn't exist. Please try again.";
    }
    config.content = typeof config.content === "string" ? config.content.slice(0, 2000) : "";
    config.name = strOrNull(config.name, 80);
    config.enabled = boolOrNull(config.enabled);
    config.delay_seconds = clampInt(config.delay_seconds, 0, 86_400);
    config.message_threshold = clampInt(config.message_threshold, 0, 1000);
    config.ignore_bots = boolOrNull(config.ignore_bots);
    config.ignore_webhooks = boolOrNull(config.ignore_webhooks);
    sanitizeRichMessage(config, ctx);
    if (!(config.content as string).trim() && !hasEmbedOrButtons(config)) {
      return "Autopilot didn't write a sticky message (text, an embed, or buttons). Please try again.";
    }
    return null;
  },
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Persist: a \"sticky\" message that Dreamliner " +
    "keeps at the bottom of a channel, reposting it automatically as new messages arrive so it " +
    "never gets buried (common uses: channel rules, a support pointer, an ongoing announcement). " +
    `You are setting this up for the server "${ctx.guildName}". Ask ONE short, plain-language ` +
    "question at a time. Never mention field names, JSON, or config, ask like a helpful person " +
    "would. Find out which channel, and what the sticky should say. When you write the message, " +
    "make it warm and specific to what was asked, never generic filler.\n\n" +
    "Everything a sticky can do: a short dashboard label (name, max 80 characters, also the webhook " +
    "name fallback), on or off (enabled), resend timing (delay_seconds: seconds of quiet after a " +
    "new message before it reposts, 0 to 86400, default 0 which reposts right away; " +
    "message_threshold: how many other messages must go by first, 0 to 1000, default 0 which " +
    "disables it; when both are set it waits for the threshold, then for the quiet delay), " +
    "ignoring bot or webhook posts so they don't bump it (ignore_bots, ignore_webhooks), and a " +
    "rich message (text, embed, link buttons, webhook name and avatar, silent, no link previews, " +
    "ping controls). The text can be \"\" when the sticky has an enabled embed or buttons. If the " +
    "channel already has a sticky, this result updates it. Never tell the user one of these " +
    "options is unsupported.\n\n" +
    RICH_MESSAGE_PROMPT_NOTES +
    " " +
    COLOR_RULE +
    "\n\n" +
    FULL_PLACEHOLDER_NOTE +
    "\n\n" +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting text channels (channel_id must be one of these ids):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    `This server's custom emoji (for button emoji, use the exact name without colons, or a Unicode emoji): ${emojiList(ctx.emojis)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of what you set up " +
    "(leave question null). channel_id always needs a real channel id.",
};
