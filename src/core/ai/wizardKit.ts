/**
 * Shared building blocks for Autopilot setup wizards (the AI_WIZARDS registry in wizards.ts and the
 * upgraded per-plugin wizards in ./wizards/). Kept separate from the registry so each wizard can
 * live in its own file without import cycles.
 */

export type AiWizardEntity = { id: string; name: string };
export type AiWizardEmoji = { id: string; name: string; animated: boolean };

export type AiWizardContext = {
  guildName: string;
  voiceChannels: AiWizardEntity[];
  textChannels: AiWizardEntity[];
  categories: AiWizardEntity[];
  roles: AiWizardEntity[];
  emojis: AiWizardEmoji[];
};

export type AiWizardTurn =
  | { action: "ask"; question: string; answerKind: AnswerKind; quickReplies?: string[] | null }
  | { action: "ready"; config: Record<string, unknown>; summary: string };

export type AiWizardDefinition = {
  maxQuestions: number;
  /** A guild-entity list this wizard can't produce a valid result without (e.g. a hub needs a
   * real voice channel to exist). Checked before the first OpenAI call, no wasted spend. */
  requiresEntity?: { kind: keyof Pick<AiWizardContext, "voiceChannels" | "textChannels">; message: string };
  buildSystemPrompt: (ctx: AiWizardContext, questionsAsked: number) => string;
  buildResultSchema: (ctx: AiWizardContext) => Record<string, unknown>;
  /** Server-side sanity check on the model's "ready" config (e.g. does the picked channel id
   * actually exist) — returns an error message if invalid, null if fine. */
  validateConfig?: (config: Record<string, unknown>, ctx: AiWizardContext) => string | null;
  /** Output budget for one turn. Defaults to 1600 (3000 in Switch import mode); raise it for
   * wizards whose "ready" config carries long text (embeds, page copy, several rules). */
  maxTokens?: number;
};
export function entityList(entities: AiWizardEntity[]): string {
  if (entities.length === 0) return "(none)";
  return entities.map((e) => `${e.id}: "${e.name}"`).join("\n");
}

export function emojiList(emojis: AiWizardEmoji[]): string {
  if (emojis.length === 0) return "(none)";
  return emojis.map((e) => `"${e.name}"`).join(", ");
}
/** Shared by every "watch messages and react to a match" wizard (Autoreactions, Autothreads,
 * Autoreplies) - kept as one list so the trigger vocabulary never drifts between them. */
export const AUTO_TRIGGERS = ["every_message", "contains", "starts_with", "exact", "regex"] as const;
export const NEVER_EM_DASH_RULE =
  "Never use em dashes in your questions or summary; use a comma, period, or 'and' instead.";

export const ANSWER_KINDS = ["text", "text_channel", "voice_channel", "role"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export const ANSWER_KIND_RULE =
  "Alongside every question, set answerKind so the dashboard can offer the right picker: " +
  "\"text_channel\" when the answer should be a text channel, \"voice_channel\" when it should be a " +
  "voice channel, \"role\" when it should be a role, or \"text\" for anything else (numbers, style " +
  "choices, yes/no, free text). When action is \"ready\", set answerKind to \"text\" (it is ignored). " +
  "If the user's answer contains a Discord mention like <#123456789012345678> or " +
  "<@&123456789012345678>, that is them using a picker: treat the id inside it as their exact, " +
  "authoritative choice and use it directly instead of matching against the name list. " +
  "Also set quickReplies whenever your question has a small number of natural preset answers (a " +
  "yes/no choice, \"all channels\" vs \"a specific channel\", picking between a few named options " +
  "you just listed, a style choice) so the dashboard can offer tap-to-answer buttons instead of " +
  "making the user type: 2 to 4 short button labels, each one something you would also accept if " +
  "typed verbatim as the answer. Set quickReplies to null when the question genuinely needs free " +
  "text you can't predict (the actual word or phrase to match, message content, a name, a number, " +
  "an emoji). When action is \"ready\", set quickReplies to null (it is ignored).";
export function progressInstruction(questionsAsked: number, maxQuestions: number): string {
  const note = `You have asked ${questionsAsked} question(s) so far out of a maximum of ${maxQuestions}. `;
  if (questionsAsked >= maxQuestions) {
    return (
      note +
      "You must respond with action \"ready\" now, filling in anything unresolved with sensible defaults.\n\n"
    );
  }
  return note;
}
export function turnSchema(configSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["ask", "ready"] },
      question: { type: ["string", "null"] },
      answerKind: { type: "string", enum: [...ANSWER_KINDS] },
      quickReplies: { type: ["array", "null"], items: { type: "string" } },
      summary: { type: ["string", "null"] },
      config: { anyOf: [{ type: "null" }, configSchema] },
    },
    required: ["action", "question", "answerKind", "quickReplies", "summary", "config"],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Upgraded-wizard toolkit: full plugin coverage without clobbering untouched settings
// ---------------------------------------------------------------------------------------------

export type IdKind = "text_channel" | "voice_channel" | "role" | "category";

const ID_KIND_SOURCES: Record<
  IdKind,
  keyof Pick<AiWizardContext, "textChannels" | "voiceChannels" | "roles" | "categories">
> = {
  text_channel: "textChannels",
  voice_channel: "voiceChannels",
  role: "roles",
  category: "categories",
};

/** OpenAI strict mode allows ~1000 enum values in a whole schema. Ids live once in $defs and are
 * referenced everywhere, and past this budget a kind falls back to a plain string (validateConfig
 * then drops unknown ids with keepIds/validId). */
const ENUM_BUDGET = 900;

function idDefs(ctx: AiWizardContext): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  let used = 0;
  for (const kind of ["text_channel", "role", "category", "voice_channel"] as const) {
    const ids = ctx[ID_KIND_SOURCES[kind]].map((e) => e.id);
    if (ids.length && used + ids.length <= ENUM_BUDGET) {
      defs[`${kind}_id`] = { type: "string", enum: ids };
      used += ids.length;
    } else {
      defs[`${kind}_id`] = { type: "string" };
    }
  }
  return defs;
}

/** A reference to one real channel/role/category id of this server (see turnSchemaWithIds). */
export function idRef(kind: IdKind): Record<string, unknown> {
  return { $ref: `#/$defs/${kind}_id` };
}

/** Makes any schema accept null. Upgraded wizards use null to mean "leave this setting as it is". */
export function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema.type;
  if (typeof type === "string" && !("enum" in schema)) return { ...schema, type: [type, "null"] };
  return { anyOf: [{ type: "null" }, schema] };
}

/** An id of this kind, or "" for "none". */
export function idOrEmpty(kind: IdKind): Record<string, unknown> {
  return { anyOf: [{ type: "string", enum: [""] }, idRef(kind)] };
}

export function idArray(kind: IdKind): Record<string, unknown> {
  return { type: "array", items: idRef(kind) };
}

/** Strict-mode object: every property required (use nullable() for optional ones). */
export function obj(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const str = (): Record<string, unknown> => ({ type: "string" });
export const int = (): Record<string, unknown> => ({ type: "integer" });
export const num = (): Record<string, unknown> => ({ type: "number" });
export const bool = (): Record<string, unknown> => ({ type: "boolean" });
export const oneOf = (values: readonly string[]): Record<string, unknown> => ({ type: "string", enum: [...values] });

/**
 * turnSchema plus a root `$defs` block holding this server's channel/role/category ids, so config
 * schemas built with idRef()/idArray()/idOrEmpty() stay small however many id fields they have.
 */
export function turnSchemaWithIds(configSchema: Record<string, unknown>, ctx: AiWizardContext): Record<string, unknown> {
  return { ...turnSchema(configSchema), $defs: idDefs(ctx) };
}

/** Prompt rule every upgraded wizard includes: null means "don't touch". */
export const NULL_MEANS_UNCHANGED_RULE =
  'Fields that accept null mean "leave this setting as it is": only give them a value when the ' +
  "user asked for it, clearly implied it, or it appears in imported notes; otherwise set them to null. " +
  "Never ask about every option. Cover what matters in a few questions and keep the rest null.";

/** Every placeholder Dreamliner's shared message templates support (core/templates.ts). */
export const FULL_PLACEHOLDER_NOTE =
  "Message placeholders you can use: {user} (mention), {user_display} (display name), {username}, " +
  "{user_id}, {user_tag}, {server} or {guild} (server name), {guild_id}, {member_count}, {channel} " +
  "(mention), {channel_name}, {channel_id}, {avatar_url}, {guild_icon_url}. Never invent other placeholders.";

/** Colors are decimal integers in the schema; tell the model so it doesn't send "#hex". */
export const COLOR_RULE = "Colors are decimal integers (for example 5793266 for #5865F2).";

// ----- validateConfig helpers -----------------------------------------------------------------

function knownIds(ctx: AiWizardContext, kind: IdKind): Set<string> {
  return new Set(ctx[ID_KIND_SOURCES[kind]].map((e) => e.id));
}

/** True for "", null and real ids of this kind. */
export function validId(value: unknown, ctx: AiWizardContext, kind: IdKind): boolean {
  return value === null || value === "" || (typeof value === "string" && knownIds(ctx, kind).has(value));
}

/** Filters an id list down to real ids of this kind; null stays null ("unchanged"). */
export function keepIds(value: unknown, ctx: AiWizardContext, kind: IdKind): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  const known = knownIds(ctx, kind);
  return [...new Set(value.filter((v): v is string => typeof v === "string" && known.has(v)))];
}

/** Clamps an integer; null stays null. */
export function clampInt(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ----- Shared rich-message sub-schemas (all fields nullable = unchanged) ------------------------

const EMBED_FIELD = obj({ name: str(), value: str(), inline: bool() });

/** Mirrors zPersistEmbedConfig (persist, role panels, tickets, giveaways, autoreplies, autothreads). */
export function persistEmbedSchema(): Record<string, unknown> {
  const icon = oneOf(["none", "guild", "bot", "url"]);
  return obj({
    enabled: nullable(bool()),
    title: nullable(str()),
    title_url: nullable(str()),
    description: nullable(str()),
    color: nullable(int()),
    author_name: nullable(str()),
    author_url: nullable(str()),
    author_icon: nullable(icon),
    author_icon_url: nullable(str()),
    thumbnail: nullable(icon),
    thumbnail_url: nullable(str()),
    image_url: nullable(str()),
    footer_text: nullable(str()),
    footer_icon: nullable(icon),
    footer_icon_url: nullable(str()),
    timestamp: nullable(bool()),
    fields: nullable({ type: "array", items: EMBED_FIELD }),
  });
}

/** Mirrors zWelcomeEmbedConfig (welcomer, member milestones, activity rewards, passport). */
export function welcomeEmbedSchema(): Record<string, unknown> {
  const icon = oneOf(["none", "avatar", "guild", "url"]);
  return obj({
    enabled: nullable(bool()),
    title: nullable(str()),
    description: nullable(str()),
    color: nullable(int()),
    author_name: nullable(str()),
    author_icon: nullable(icon),
    author_icon_url: nullable(str()),
    thumbnail: nullable(icon),
    thumbnail_url: nullable(str()),
    image: nullable(oneOf(["none", "url"])),
    image_url: nullable(str()),
    footer_text: nullable(str()),
    footer_icon: nullable(icon),
    footer_icon_url: nullable(str()),
    timestamp: nullable(bool()),
    fields: nullable({ type: "array", items: EMBED_FIELD }),
  });
}

/** Mirrors zWelcomeCardConfig (the generated image card). Uploaded-asset backgrounds stay a dashboard-only choice. */
export function welcomeCardSchema(): Record<string, unknown> {
  return obj({
    enabled: nullable(bool()),
    background_type: nullable(oneOf(["color", "url"])),
    background_color: nullable(int()),
    background_url: nullable(str()),
    avatar_layout: nullable(oneOf(["left", "center", "right"])),
    text_layout: nullable(oneOf(["beside", "below", "overlay_center", "overlay_bottom"])),
    avatar_style: nullable(oneOf(["circle", "rounded_square"])),
    show_avatar: nullable(bool()),
    show_accent_bar: nullable(bool()),
    greeting_text: nullable(str()),
    subtitle_text: nullable(str()),
    text_color: nullable(int()),
    accent_color: nullable(int()),
    border_color: nullable(int()),
    border_width: nullable(int()),
    border_radius: nullable(int()),
    avatar_size: nullable(int()),
    avatar_offset_x: nullable(int()),
    avatar_offset_y: nullable(int()),
    text_offset_x: nullable(int()),
    text_offset_y: nullable(int()),
    greeting_size: nullable(int()),
    subtitle_size: nullable(int()),
    avatar_ring_width: nullable(int()),
  });
}

/** Mirrors zPersistButton: up to 5 link buttons (null = unchanged). */
export function linkButtonsSchema(): Record<string, unknown> {
  return nullable({ type: "array", items: obj({ label: str(), url: str(), emoji: str() }) });
}
