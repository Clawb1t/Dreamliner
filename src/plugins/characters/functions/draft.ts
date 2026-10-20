import { generateStructured, type ChatTurn } from "../../../core/ai/client.js";
import { censorProfanity } from "../../../core/profanityFilter.js";
import { matchWordPack } from "../../automod/functions/detectors/wordMatch.js";
import { SLUR_WORDS } from "../../automod/functions/packs/slurs.js";
import {
  CATCHPHRASE_LIMITS,
  CHARACTER_LIMITS,
  CHARACTER_TONES,
  DRAFT_DESCRIPTION_MAX,
  EMOJI_USES,
  FORMALITIES,
  type CharacterTone,
  type EmojiUse,
  type Formality,
} from "../constants.js";
import { TONE_GUIDE } from "./prompt.js";
import { HARD_RULES, checkCharacterName } from "./safety.js";

/**
 * Autopilot for Characters: writes a first draft of a character from a short description. Same
 * OpenAI client and shared Autopilot usage gate as every other Autopilot feature (called from
 * bridge/webAi.ts); DeepSeek is only for replies and the safety review. The draft is only filled
 * into the dashboard form; saving it still goes through the normal character review.
 */

export type CharacterDraft = {
  name: string;
  tone: CharacterTone;
  emojiUse: EmojiUse;
  formality: Formality;
  roleplayActions: boolean;
  tagline: string;
  personality: string;
  scenario: string;
  greeting: string;
  exampleDialogue: string;
  catchphrases: string[];
};

export type DraftRequest = { description: string; name?: string; tone?: CharacterTone };

/** At most this many catchphrases in a draft (managers can add up to CATCHPHRASE_LIMITS.count). */
const DRAFT_CATCHPHRASES = 3;

const TONE_LIST = CHARACTER_TONES.map((tone) => `- ${tone}: ${TONE_GUIDE[tone].replace(/^Your tone is \w+: /, "")}`).join("\n");

export const DRAFT_SYSTEM = [
  "You write ORIGINAL AI roleplay characters for a Discord community server, from a short description by the server manager.",
  "The character must follow these rules:",
  ...HARD_RULES.map((rule, i) => `${i + 1}. ${rule}`),
  "Never base the character on a real person (celebrity, politician, streamer, server member) or on a copyrighted character; invent an original one inspired by the description.",
  "No sexual, romantic-with-minors, hateful, self-harm or real-violence themes. Villains and spooky or grumpy characters are fine when played for fun.",
  "The name must not contain Discord, Clyde, mod, admin, staff, official, everyone or here, and must not pose as the Dreamliner bot.",
  "If the description asks for something against these rules, write a safe, friendly character loosely inspired by the harmless parts instead.",
  "",
  "Tone presets (pick the one that fits best):",
  TONE_LIST,
  "",
  "Fill in every field:",
  `- name: an original name, max ${CHARACTER_LIMITS.name} characters.`,
  "- tone: the best fitting tone preset.",
  '- emojiUse: "none", "some" or "lots". formality: "casual", "balanced" or "formal".',
  "- roleplayActions: whether it uses short *actions* in asterisks.",
  `- tagline: one short line, max ${CHARACTER_LIMITS.tagline} characters.`,
  "- personality: who they are (personality, way of speaking, quirks, likes, backstory), about 600 to 900 characters, in the third person.",
  "- scenario: the setting or situation they are in, 1 to 3 sentences.",
  "- greeting: their first message to the server, 1 to 3 sentences, addressing {{user}}.",
  '- exampleDialogue: 2 or 3 short exchanges, each line starting with "{{user}}:" or "{{char}}:", separated by newlines.',
  `- catchphrases: 0 to ${DRAFT_CATCHPHRASES} short phrases they say now and then, each max ${CATCHPHRASE_LIMITS.length} characters.`,
  "Write in English unless the description is in another language. No markdown headings.",
].join("\n");

/** Strict JSON schema for OpenAI structured output (every field required, no extras). */
export const DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "tone",
    "emojiUse",
    "formality",
    "roleplayActions",
    "tagline",
    "personality",
    "scenario",
    "greeting",
    "exampleDialogue",
    "catchphrases",
  ],
  properties: {
    name: { type: "string" },
    tone: { type: "string", enum: [...CHARACTER_TONES] },
    emojiUse: { type: "string", enum: [...EMOJI_USES] },
    formality: { type: "string", enum: [...FORMALITIES] },
    roleplayActions: { type: "boolean" },
    tagline: { type: "string" },
    personality: { type: "string" },
    scenario: { type: "string" },
    greeting: { type: "string" },
    exampleDialogue: { type: "string" },
    catchphrases: { type: "array", items: { type: "string" } },
  },
};

export function buildDraftMessages(request: DraftRequest): ChatTurn[] {
  const lines = [`Description: ${request.description.trim()}`];
  if (request.name?.trim()) lines.push(`Name (use exactly this): ${request.name.trim()}`);
  if (request.tone) lines.push(`Tone (use exactly this): ${request.tone}`);
  else lines.push("Tone: pick the best fitting preset.");
  return [
    { role: "system", content: DRAFT_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const out = value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (lastBreak > max * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trim();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function hasSlur(value: string): boolean {
  return matchWordPack(value, SLUR_WORDS).length > 0;
}

/** Example dialogue as clean {{user}}: / {{char}}: lines (the model sometimes uses names). */
function dialogue(value: unknown, name: string): string {
  const raw = text(value, CHARACTER_LIMITS.exampleDialogue * 2);
  if (!raw) return "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let out = line.replace(/^\*\*(.+?)\*\*\s*:/, "$1:");
      if (name) out = out.replace(new RegExp(`^${escaped}\\s*:`, "i"), "{{char}}:");
      out = out.replace(/^(?:user|member)\s*:/i, "{{user}}:").replace(/^(?:char|character)\s*:/i, "{{char}}:");
      return out;
    });
  return text(lines.join("\n"), CHARACTER_LIMITS.exampleDialogue);
}

/**
 * Validates and trims the model's JSON into a draft. A name or tone the manager gave wins over the
 * model's. Null when there's nothing usable (no personality) or the text contains a slur.
 */
export function parseCharacterDraft(raw: unknown, request: DraftRequest): CharacterDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;

  const given = request.name?.trim().replace(/\s+/g, " ").slice(0, CHARACTER_LIMITS.name) ?? "";
  const suggested = text(value.name, CHARACTER_LIMITS.name).replace(/\s+/g, " ");
  const name = given || (suggested && !checkCharacterName(suggested) ? suggested : "");

  const personality = text(value.personality, CHARACTER_LIMITS.personality);
  if (!personality) return null;

  const catchphrases: string[] = [];
  for (const item of Array.isArray(value.catchphrases) ? value.catchphrases : []) {
    if (typeof item !== "string") continue;
    const phrase = item.replace(/\s+/g, " ").trim().slice(0, CATCHPHRASE_LIMITS.length).trim();
    if (!phrase || hasSlur(phrase) || censorProfanity(phrase) !== phrase) continue;
    if (catchphrases.some((p) => p.toLowerCase() === phrase.toLowerCase())) continue;
    catchphrases.push(phrase);
    if (catchphrases.length >= DRAFT_CATCHPHRASES) break;
  }

  let tagline = text(value.tagline, CHARACTER_LIMITS.tagline).replace(/\n+/g, " ");
  if (censorProfanity(tagline) !== tagline) tagline = "";

  const draft: CharacterDraft = {
    name,
    tone: request.tone || oneOf(value.tone, CHARACTER_TONES, "warm"),
    emojiUse: oneOf(value.emojiUse, EMOJI_USES, "some"),
    formality: oneOf(value.formality, FORMALITIES, "balanced"),
    roleplayActions: typeof value.roleplayActions === "boolean" ? value.roleplayActions : true,
    tagline,
    personality,
    scenario: text(value.scenario, CHARACTER_LIMITS.scenario),
    greeting: text(value.greeting, CHARACTER_LIMITS.greeting),
    exampleDialogue: dialogue(value.exampleDialogue, name || suggested),
    catchphrases,
  };
  const all = [draft.name, draft.tagline, draft.personality, draft.scenario, draft.greeting, draft.exampleDialogue].join("\n");
  if (hasSlur(all)) return null;
  return draft;
}

/** Checks the dashboard's request body. */
export function parseDraftRequest(body: Record<string, unknown>): { ok: true; value: DraftRequest } | { ok: false; error: string; field: string } {
  const description = typeof body.description === "string" ? body.description.replace(/\r\n/g, "\n").trim() : "";
  if (!description) return { ok: false, error: "Describe the character you want.", field: "description" };
  if (description.length > DRAFT_DESCRIPTION_MAX) {
    return { ok: false, error: `Keep the description to ${DRAFT_DESCRIPTION_MAX} characters or fewer.`, field: "description" };
  }
  if (hasSlur(description)) return { ok: false, error: "The description contains a slur.", field: "description" };
  let name: string | undefined;
  if (body.name !== undefined && body.name !== null && body.name !== "") {
    if (typeof body.name !== "string") return { ok: false, error: "Expected text.", field: "name" };
    const trimmed = body.name.trim().replace(/\s+/g, " ");
    if (trimmed) {
      const problem = checkCharacterName(trimmed);
      if (problem) return { ok: false, error: problem, field: "name" };
      name = trimmed;
    }
  }
  let tone: CharacterTone | undefined;
  if (body.tone !== undefined && body.tone !== null && body.tone !== "") {
    if (typeof body.tone !== "string" || !(CHARACTER_TONES as readonly string[]).includes(body.tone)) {
      return { ok: false, error: "Pick one of the tone presets.", field: "tone" };
    }
    tone = body.tone as CharacterTone;
  }
  return { ok: true, value: { description, name, tone } };
}

type StructuredCall = (input: { messages: ChatTurn[]; schemaName: string; schema: Record<string, unknown>; maxTokens?: number }) => Promise<unknown>;

/** Asks Autopilot (OpenAI) for a draft. Throws when it failed or came back unusable. */
export async function generateCharacterDraft(request: DraftRequest, deps: { call?: StructuredCall } = {}): Promise<CharacterDraft> {
  const call = deps.call ?? generateStructured;
  const raw = await call({ messages: buildDraftMessages(request), schemaName: "character_draft", schema: DRAFT_SCHEMA, maxTokens: 1600 });
  const draft = parseCharacterDraft(raw, request);
  if (!draft) throw new Error("Autopilot's character came back unusable. Try rewording the description.");
  return draft;
}
