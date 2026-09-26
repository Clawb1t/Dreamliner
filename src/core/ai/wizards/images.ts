import { FREE_IMAGE_DAILY_SENDS, IMAGE_SOURCES, isValidTimeZone } from "../../../config/schemas/images.js";
import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  entityList,
  idRef,
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
/** Most daily sends one run adds (the free-tier cap; the dashboard enforces the server's real limit). */
export const MAX_IMAGE_SENDS_PER_RUN = FREE_IMAGE_DAILY_SENDS;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function imagesConfigSchema(): Record<string, unknown> {
  return obj({
    daily: {
      type: "array",
      items: obj({
        channel_id: idRef("text_channel"),
        source: oneOf(IMAGE_SOURCES),
        time: nullable(str()),
        timezone: nullable(str()),
        enabled: nullable(bool()),
      }),
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns "9:05" into "09:05"; anything that still isn't 24-hour HH:MM becomes null (default time). */
function normalizeTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const padded = /^\d:\d\d$/.test(trimmed) ? `0${trimmed}` : trimmed;
  return TIME_RE.test(padded) ? padded : null;
}

export function validateImagesConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const raw = Array.isArray(config.daily) ? config.daily.filter(isObject) : [];
  const daily: Record<string, unknown>[] = [];
  for (const d of raw.slice(0, MAX_IMAGE_SENDS_PER_RUN)) {
    if (typeof d.channel_id !== "string" || !ctx.textChannels.some((c) => c.id === d.channel_id)) continue;
    const timezone = typeof d.timezone === "string" && d.timezone.trim() ? d.timezone.trim() : null;
    daily.push({
      channel_id: d.channel_id,
      source: (IMAGE_SOURCES as readonly string[]).includes(d.source as string) ? d.source : "anime",
      time: normalizeTime(d.time),
      timezone: timezone && isValidTimeZone(timezone) ? timezone : null,
      enabled: typeof d.enabled === "boolean" ? d.enabled : null,
    });
  }
  if (daily.length === 0) {
    return "Autopilot picked a channel that doesn't exist. Please try again.";
  }
  config.daily = daily;
  return null;
}

export const imagesWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2000,
  requiresEntity: {
    kind: "textChannels",
    message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) => turnSchemaWithIds(imagesConfigSchema(), ctx),
  validateConfig: validateImagesConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Daily Images: once a day, Dreamliner posts a " +
    "fresh random image into a chosen channel. The kinds (source) are: \"anime\" (anime art: nekos, " +
    "waifus, kitsunes, husbandos), \"blahaj\" (photos of the IKEA Blahaj shark plush), and animal " +
    "photos: \"cat\", \"dog\", \"fox\", \"duck\", \"capybara\", \"bird\". They can set up several " +
    `daily sends in one go (up to ${MAX_IMAGE_SENDS_PER_RUN}, for example a cat in #cats every ` +
    "morning and a dog in #dogs every evening), each one is added as a new daily send. You are " +
    `setting this up for the server "${ctx.guildName}". Ask ONE short, plain-language question at a ` +
    "time. Never mention field names, JSON, or config, ask like a helpful person would. Find out " +
    "which kind of image, which channel, and what time of day. If the channel name or the user's " +
    "wording already makes the kind of image obvious, don't ask about it. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting text channels (pick channel_id from these ids only):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "time is 24-hour \"HH:MM\" (e.g. \"09:00\", \"18:30\"); turn answers like \"9am\" or " +
    "\"evening\" into a sensible exact time, null uses \"12:00\". timezone is an IANA timezone name " +
    "like \"Europe/London\", \"America/New_York\", or \"Asia/Tokyo\". When the user gives a time, ask " +
    "which timezone (or city/country) they mean unless they already said, and map their answer to " +
    "the matching IANA name; null uses the admin's own timezone. enabled false adds a send switched " +
    "off (null = on).\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config (at least one daily send) and a short, friendly plain-language " +
    "summary of the choices you made (leave question null). channel_id always needs a real channel " +
    "id, never invent one.",
};
