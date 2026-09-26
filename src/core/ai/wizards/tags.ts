/**
 * Tags Autopilot wizard: creates one or more tags per run (a Switch import can bring over a whole
 * list of MEE6/Dyno custom commands or FAQ snippets at once). Tags live in the database, not the
 * plugin config (which only holds permissions), so name and content are the only settings. Names
 * and content are clamped to the same rules the tags bridge enforces (bridge/webTags.ts).
 */
import {
  ANSWER_KIND_RULE,
  FULL_PLACEHOLDER_NOTE,
  NEVER_EM_DASH_RULE,
  obj,
  progressInstruction,
  str,
  turnSchemaWithIds,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { isRow } from "./autoRuleKit.js";

const MAX_QUESTIONS = 3;
export const MAX_TAGS_PER_RUN = 15;
export const MAX_TAG_NAME_LENGTH = 64;
export const MAX_TAG_CONTENT_LENGTH = 2000;
const TAG_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function tagsConfigSchema(): Record<string, unknown> {
  return obj({
    tags: { type: "array", items: obj({ name: str(), content: str() }) },
  });
}

/** Turns "FAQ Payment!" into "faq-payment"; "" when nothing usable is left. */
export function normalizeTagName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/^\//, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+/, "")
    .slice(0, MAX_TAG_NAME_LENGTH);
  return TAG_NAME_RE.test(name) ? name : "";
}

export const validateTagsConfig: NonNullable<AiWizardDefinition["validateConfig"]> = (config) => {
  const seen = new Set<string>();
  const tags: { name: string; content: string }[] = [];
  for (const row of Array.isArray(config.tags) ? config.tags.filter(isRow) : []) {
    const name = typeof row.name === "string" ? normalizeTagName(row.name) : "";
    const content = typeof row.content === "string" ? row.content.trim().slice(0, MAX_TAG_CONTENT_LENGTH) : "";
    if (!name || !content || seen.has(name)) continue;
    seen.add(name);
    tags.push({ name, content });
  }
  if (tags.length === 0) return "Autopilot didn't produce a usable tag (each needs a name and some content). Please try again.";
  config.tags = tags.slice(0, MAX_TAGS_PER_RUN);
  return null;
};

export const tagsWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 4000,
  buildResultSchema: (ctx) => turnSchemaWithIds(tagsConfigSchema(), ctx),
  validateConfig: validateTagsConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin create Tags: reusable snippets of text a moderator can " +
    `post with a slash command (e.g. /tag show rules). You are setting this up for the server "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config, " +
    "ask like a helpful person would.\n\n" +
    `You can create several tags in one go (up to ${MAX_TAGS_PER_RUN}). Each tag has a name and content. ` +
    "The name is what people type to use it: lowercase letters, numbers, _ or -, starting with a " +
    `letter or number, no spaces, max ${MAX_TAG_NAME_LENGTH} characters (e.g. "rules" or "faq-payment"). ` +
    `The content is the message it posts, max ${MAX_TAG_CONTENT_LENGTH} characters, and supports Discord ` +
    "markdown. Find out what each tag is for (rules, an FAQ answer, a support pointer) and what it " +
    "should say. When you write content, make it warm and specific to what was asked, never generic " +
    "filler. If the user or imported notes give exact text, keep it word for word. Tags that already " +
    "exist on the server are skipped, not overwritten. " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nContent placeholders (use naturally, at most a couple): " +
    FULL_PLACEHOLDER_NOTE +
    " {memberCount} also works as the member count.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the tags you made (leave " +
    "question null). tags always needs at least one entry with a real name and content.",
};
