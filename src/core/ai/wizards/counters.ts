import { COUNTER_DISPLAYS, COUNTER_METRICS } from "../../../config/schemas/counters.js";
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
/** Most counters one Autopilot run adds; more can be added by running it again or on the dashboard. */
export const MAX_COUNTERS_PER_RUN = 10;

function counterSchema(): Record<string, unknown> {
  return obj({
    metric: oneOf(COUNTER_METRICS),
    display: oneOf(COUNTER_DISPLAYS),
    channel_id: { anyOf: [idRef("text_channel"), idRef("voice_channel")] },
    name: nullable(str()),
    enabled: nullable(bool()),
    format: nullable(str()),
    refresh_minutes: nullable(int()),
    value: nullable(int()),
  });
}

export function countersConfigSchema(): Record<string, unknown> {
  return obj({ counters: { type: "array", items: counterSchema() } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCountersConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const raw = Array.isArray(config.counters) ? config.counters.filter(isObject) : [];
  const counters: Record<string, unknown>[] = [];
  for (const c of raw.slice(0, MAX_COUNTERS_PER_RUN)) {
    const display = (COUNTER_DISPLAYS as readonly string[]).includes(c.display as string) ? c.display : "message";
    const metric = (COUNTER_METRICS as readonly string[]).includes(c.metric as string) ? c.metric : "members";
    const list = display === "voice_name" ? ctx.voiceChannels : ctx.textChannels;
    if (typeof c.channel_id !== "string" || !list.some((ch) => ch.id === c.channel_id)) continue;
    counters.push({
      metric,
      display,
      channel_id: c.channel_id,
      name: typeof c.name === "string" ? c.name.trim().slice(0, 80) : null,
      enabled: typeof c.enabled === "boolean" ? c.enabled : null,
      format: typeof c.format === "string" && c.format.trim() ? c.format.slice(0, 100) : null,
      refresh_minutes: clampInt(c.refresh_minutes, 5, 1440),
      value: clampInt(c.value, 0, 2_147_483_647),
    });
  }
  if (counters.length === 0) {
    return "Autopilot picked a channel that doesn't match, or doesn't exist. Please try again.";
  }
  config.counters = counters;
  return null;
}

export const countersWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2500,
  buildResultSchema: (ctx) => turnSchemaWithIds(countersConfigSchema(), ctx),
  validateConfig: validateCountersConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up live counters (a number shown as a message or " +
    `a channel name, e.g. member count). You are setting this up for the server "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config, " +
    "ask like a helpful person would. Find out what they want to count and where they want it " +
    "shown. They can set up several counters at once (for example a members counter and a boosts " +
    `counter), up to ${MAX_COUNTERS_PER_RUN} in one go, each becomes a new counter. ` +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nWhat it can count (metric): members (server member count, updates automatically), messages " +
    "(total messages sent, updates automatically), boosts (server boost count, updates " +
    "automatically), custom (a number they set themselves from the dashboard, ask for a starting " +
    "value if they pick this and put it in value, 0 to 2147483647).\n\n" +
    "Where it shows (display): message (a message that stays updated in a text channel), " +
    "channel_name (renames a text channel to include the count), voice_name (renames a voice " +
    "channel to include the count, the classic \"Members: 1,234\" stats channel). channel_id must be a " +
    "text channel for message/channel_name, or a voice channel for voice_name.\n\n" +
    "Per counter options (null = default): name (dashboard label, and the embed label for message " +
    "display, max 80 characters), enabled (false adds it switched off), format (the displayed text, " +
    "max 100 characters, {value} is replaced by the formatted count, e.g. \"Members: {value}\", " +
    "default \"{value}\"), refresh_minutes (5 to 1440, minimum minutes between channel renames, " +
    "Discord only allows 2 renames per 10 minutes, default 10, ignored for message display), " +
    "value (starting number for custom counters).\n\n" +
    "Existing text channels:\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Existing voice channels:\n" +
    `${entityList(ctx.voiceChannels)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config (at least one counter) and a short, friendly plain-language summary of the " +
    "choices you made (leave question null). channel_id always needs a real id from the lists above " +
    "matching the chosen display, never invent one.",
};
