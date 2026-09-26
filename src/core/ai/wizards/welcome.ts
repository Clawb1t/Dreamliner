/**
 * Autopilot wizard for the Welcomer (plugin welcome_message). Covers the join, leave and DM
 * messages (content, full embed, full image card), the wave button, the first-message reaction,
 * early-leave cleanup, the Passport hold, and member-count milestones. Every setting is nullable:
 * null means "leave it as it is", so applying a result never resets anything nobody talked about.
 */
import { resolveEmojiByName } from "../../emoji.js";
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
  idOrEmpty,
  int,
  nullable,
  obj,
  oneOf,
  progressInstruction,
  str,
  turnSchemaWithIds,
  validId,
  welcomeCardSchema,
  welcomeEmbedSchema,
  type AiWizardContext,
  type AiWizardDefinition,
  type IdKind,
} from "../wizardKit.js";

const MAX_QUESTIONS = 8;
const MAX_MILESTONES = 50;

type Rec = Record<string, unknown>;

export function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string trimmed to `max` characters; anything that isn't a string becomes null ("unchanged"). */
export function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

export function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function enumOrNull(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

const color = (value: unknown) => clampInt(value, 0, 0xffffff);

// ----- Shared rich-message sanitizers (also used by the Passport wizard) -----------------------

const WELCOME_ICONS = ["none", "avatar", "guild", "url"] as const;

/** Mirrors zWelcomeEmbedConfig bounds on a welcomeEmbedSchema() result, in place. */
export function sanitizeWelcomeEmbed(raw: unknown): Rec | null {
  if (!isRec(raw)) return null;
  raw.enabled = boolOrNull(raw.enabled);
  raw.title = text(raw.title, 256);
  raw.description = text(raw.description, 4096);
  raw.color = color(raw.color);
  raw.author_name = text(raw.author_name, 256);
  raw.author_icon = enumOrNull(raw.author_icon, WELCOME_ICONS);
  raw.author_icon_url = text(raw.author_icon_url, 512);
  raw.thumbnail = enumOrNull(raw.thumbnail, WELCOME_ICONS);
  raw.thumbnail_url = text(raw.thumbnail_url, 512);
  raw.image = enumOrNull(raw.image, ["none", "url"]);
  raw.image_url = text(raw.image_url, 512);
  raw.footer_text = text(raw.footer_text, 2048);
  raw.footer_icon = enumOrNull(raw.footer_icon, WELCOME_ICONS);
  raw.footer_icon_url = text(raw.footer_icon_url, 512);
  raw.timestamp = boolOrNull(raw.timestamp);
  raw.fields = Array.isArray(raw.fields)
    ? raw.fields
        .filter(isRec)
        .map((f) => ({
          name: text(f.name, 256) ?? "",
          value: text(f.value, 1024) ?? "",
          inline: f.inline === true,
        }))
        .filter((f) => f.name.trim() || f.value.trim())
        .slice(0, 25)
    : null;
  return raw;
}

/** Mirrors zWelcomeCardConfig bounds on a welcomeCardSchema() result, in place. */
export function sanitizeWelcomeCard(raw: unknown): Rec | null {
  if (!isRec(raw)) return null;
  raw.enabled = boolOrNull(raw.enabled);
  raw.background_type = enumOrNull(raw.background_type, ["color", "url"]);
  raw.background_color = color(raw.background_color);
  raw.background_url = text(raw.background_url, 512);
  raw.avatar_layout = enumOrNull(raw.avatar_layout, ["left", "center", "right"]);
  raw.text_layout = enumOrNull(raw.text_layout, ["beside", "below", "overlay_center", "overlay_bottom"]);
  raw.avatar_style = enumOrNull(raw.avatar_style, ["circle", "rounded_square"]);
  raw.show_avatar = boolOrNull(raw.show_avatar);
  raw.show_accent_bar = boolOrNull(raw.show_accent_bar);
  raw.greeting_text = text(raw.greeting_text, 200);
  raw.subtitle_text = text(raw.subtitle_text, 200);
  raw.text_color = color(raw.text_color);
  raw.accent_color = color(raw.accent_color);
  raw.border_color = color(raw.border_color);
  raw.border_width = clampInt(raw.border_width, 0, 32);
  raw.border_radius = clampInt(raw.border_radius, 0, 80);
  raw.avatar_size = clampInt(raw.avatar_size, 64, 240);
  raw.avatar_offset_x = clampInt(raw.avatar_offset_x, -400, 400);
  raw.avatar_offset_y = clampInt(raw.avatar_offset_y, -200, 200);
  raw.text_offset_x = clampInt(raw.text_offset_x, -400, 400);
  raw.text_offset_y = clampInt(raw.text_offset_y, -200, 200);
  raw.greeting_size = clampInt(raw.greeting_size, 18, 72);
  raw.subtitle_size = clampInt(raw.subtitle_size, 12, 48);
  raw.avatar_ring_width = clampInt(raw.avatar_ring_width, 0, 16);
  // A url background with an explicitly empty url would render nothing: keep the current type.
  if (raw.background_type === "url" && typeof raw.background_url === "string" && !raw.background_url.trim()) {
    raw.background_type = null;
  }
  return raw;
}

/** An emoji field: resolves a bare custom emoji name ("blahaj") to <:blahaj:id>; null stays null. */
export function resolveEmojiField(value: unknown, ctx: AiWizardContext, max = 128): string | null {
  if (typeof value !== "string") return null;
  return resolveEmojiByName(value, ctx.emojis).slice(0, max);
}

/** An id (or "" for none) that isn't real becomes null ("unchanged") instead of failing the run. */
export function idOrNull(value: unknown, ctx: AiWizardContext, kind: IdKind = "text_channel"): string | null {
  return typeof value === "string" && validId(value, ctx, kind) ? value : null;
}

// ----- Schema ------------------------------------------------------------------------------------

const EMBED_REF = { $ref: "#/$defs/welcome_embed" };
const CARD_REF = { $ref: "#/$defs/welcome_card" };

function welcomeConfigSchema(): Record<string, unknown> {
  const event = (withChannel: boolean) =>
    nullable(
      obj({
        enabled: nullable(bool()),
        ...(withChannel ? { channel_id: nullable(idOrEmpty("text_channel")) } : {}),
        content: nullable(str()),
        embed: nullable(EMBED_REF),
        card: nullable(CARD_REF),
      }),
    );

  const milestone = obj({
    count: int(),
    enabled: nullable(bool()),
    name: nullable(str()),
    channel_id: nullable(idOrEmpty("text_channel")),
    message_mode: nullable(oneOf(["default", "custom"])),
    message: nullable(
      obj({ content: nullable(str()), embed: nullable(EMBED_REF), card: nullable(CARD_REF) }),
    ),
  });

  return obj({
    join: event(true),
    leave: event(true),
    dm: event(false),
    wave_button: nullable(obj({ enabled: nullable(bool()), label: nullable(str()), emoji: nullable(str()) })),
    first_message_react: nullable(obj({ enabled: nullable(bool()), emoji: nullable(str()) })),
    delete_join_on_early_leave: nullable(bool()),
    require_passport_verification: nullable(bool()),
    member_milestones: nullable(
      obj({
        enabled: nullable(bool()),
        channel_id: nullable(idOrEmpty("text_channel")),
        content: nullable(str()),
        embed: nullable(EMBED_REF),
        card: nullable(CARD_REF),
        milestones: nullable({ type: "array", items: milestone }),
      }),
    ),
  });
}

/** Card fields whose defaults are hand-tuned; the model tends to fill them with worse values. */
const CARD_FINE_TUNE_FIELDS = [
  "border_width",
  "border_radius",
  "avatar_size",
  "avatar_offset_x",
  "avatar_offset_y",
  "text_offset_x",
  "text_offset_y",
  "greeting_size",
  "subtitle_size",
  "avatar_ring_width",
];

/** welcomeCardSchema() with a "keep null" hint on the pixel fine-tuning fields. */
export function hintedWelcomeCardSchema(): Record<string, unknown> {
  const card = welcomeCardSchema();
  const props = card.properties as Record<string, Rec>;
  for (const key of CARD_FINE_TUNE_FIELDS) {
    props[key] = { ...props[key], description: "Pixels. Keep null (tuned default) unless the user asks for this." };
  }
  return card;
}

export function buildWelcomeResultSchema(ctx: AiWizardContext): Record<string, unknown> {
  const schema = turnSchemaWithIds(welcomeConfigSchema(), ctx);
  return {
    ...schema,
    $defs: {
      ...(schema.$defs as Rec),
      welcome_embed: welcomeEmbedSchema(),
      welcome_card: hintedWelcomeCardSchema(),
    },
  };
}

// ----- Validation --------------------------------------------------------------------------------

function sanitizeEvent(raw: unknown, ctx: AiWizardContext, withChannel: boolean): Rec | null {
  if (!isRec(raw)) return null;
  raw.enabled = boolOrNull(raw.enabled);
  if (withChannel) raw.channel_id = idOrNull(raw.channel_id, ctx);
  else delete raw.channel_id;
  raw.content = text(raw.content, 2000);
  raw.embed = sanitizeWelcomeEmbed(raw.embed);
  raw.card = sanitizeWelcomeCard(raw.card);
  return raw;
}

function sanitizeMilestones(raw: unknown, ctx: AiWizardContext): Rec[] | null {
  if (!Array.isArray(raw)) return null;
  const byCount = new Map<number, Rec>();
  for (const item of raw) {
    if (!isRec(item)) continue;
    const count = clampInt(item.count, 2, 100_000_000);
    if (count === null) continue;
    const message = isRec(item.message)
      ? {
          content: text(item.message.content, 2000),
          embed: sanitizeWelcomeEmbed(item.message.embed),
          card: sanitizeWelcomeCard(item.message.card),
        }
      : null;
    byCount.set(count, {
      count,
      enabled: boolOrNull(item.enabled),
      name: text(item.name, 80),
      channel_id: idOrNull(item.channel_id, ctx),
      message_mode: enumOrNull(item.message_mode, ["default", "custom"]),
      message,
    });
  }
  return [...byCount.values()].slice(0, MAX_MILESTONES);
}

export function validateWelcomeConfig(config: Rec, ctx: AiWizardContext): string | null {
  config.join = sanitizeEvent(config.join, ctx, true);
  config.leave = sanitizeEvent(config.leave, ctx, true);
  config.dm = sanitizeEvent(config.dm, ctx, false);

  if (isRec(config.wave_button)) {
    const wave = config.wave_button;
    wave.enabled = boolOrNull(wave.enabled);
    wave.label = text(wave.label, 80);
    wave.emoji = resolveEmojiField(wave.emoji, ctx);
    if (wave.label === "") wave.label = null;
    if (wave.emoji === "") wave.emoji = null;
  } else {
    config.wave_button = null;
  }

  if (isRec(config.first_message_react)) {
    const react = config.first_message_react;
    react.enabled = boolOrNull(react.enabled);
    react.emoji = resolveEmojiField(react.emoji, ctx);
  } else {
    config.first_message_react = null;
  }

  config.delete_join_on_early_leave = boolOrNull(config.delete_join_on_early_leave);
  config.require_passport_verification = boolOrNull(config.require_passport_verification);

  if (isRec(config.member_milestones)) {
    const mm = config.member_milestones;
    mm.enabled = boolOrNull(mm.enabled);
    mm.channel_id = idOrNull(mm.channel_id, ctx);
    mm.content = text(mm.content, 2000);
    mm.embed = sanitizeWelcomeEmbed(mm.embed);
    mm.card = sanitizeWelcomeCard(mm.card);
    mm.milestones = sanitizeMilestones(mm.milestones, ctx);
  } else {
    config.member_milestones = null;
  }
  return null;
}

// ----- Prompt ------------------------------------------------------------------------------------

function buildWelcomePrompt(ctx: AiWizardContext, questionsAsked: number): string {
  return (
    "You are helping a Discord server admin set up Dreamliner's Welcomer for the server " +
    `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field ` +
    "names, JSON, or config, ask like a helpful person would.\n\n" +
    "What the Welcomer can do:\n" +
    "- Join message: posted in a channel when someone joins. Plain text, a Discord embed, an " +
    "image welcome card, or any mix of the three.\n" +
    "- Leave message: the same thing when someone leaves, in its own channel.\n" +
    "- DM: a private message to the new member (text, embed and/or card), skipped if their DMs are closed.\n" +
    "- Embeds (for join, leave, DM and milestones): title, description, color, author name and " +
    "icon (member avatar, server icon, or an image URL), thumbnail (avatar, server icon, URL, or " +
    "none), a large image URL, footer text and icon, a timestamp, and up to 25 fields.\n" +
    "- Image card (for join, leave, DM and milestones): background color or image URL, avatar " +
    "position (left, center, right) and shape (circle or rounded square), text position (beside, " +
    "below, centered overlay, bottom overlay), greeting and subtitle text, text/accent/border " +
    "colors, border width and corner radius, avatar size and ring width, font sizes, and " +
    "pixel nudges for the avatar and text. Uploaded background images are picked in the dashboard.\n" +
    "- Wave button on the join message so members can wave at the newcomer (label and emoji).\n" +
    "- React to a new member's first message with an emoji.\n" +
    "- Delete the join message if the member leaves within 24 hours.\n" +
    "- Hold the join message and DM until the member passes Passport verification.\n" +
    "- Member milestones: celebrate when the server hits a member count (for example 1,000), " +
    "with a shared message (text, embed, card) in a default channel, and per-milestone overrides " +
    "(own channel, own name, or its own custom message when message_mode is \"custom\"). " +
    "Milestones are added or updated by count; existing ones are kept.\n\n" +
    "Focus on: which channel gets the join message, the tone (casual, hype, chill, formal, " +
    "matching the server's vibe), plain message vs embed vs image card, and whether they also " +
    "want a leave message or a DM. Only bring up the rest if the user mentions it or it feels " +
    "natural. When you write message, embed or card text, make it warm and specific to this " +
    "server, never generic filler like \"Welcome!\". Card and embed text should riff on the " +
    "plain message, not repeat it verbatim.\n\n" +
    NULL_MEANS_UNCHANGED_RULE +
    " A whole section (join, leave, dm, embed, card, wave_button, member_milestones...) can be " +
    "null when nothing in it changes. To turn an event off set its enabled to false. " +
    'channel_id "" clears the channel. ' +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\n" +
    FULL_PLACEHOLDER_NOTE +
    " The Welcomer also accepts {user_name} and {guild_member_count}; milestone messages also " +
    "get {milestone} (the count, like 1,000) and {milestone_name}. " +
    COLOR_RULE +
    "\n\nExisting text channels (channel ids must come from this list):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "This server's custom emoji (for the wave button or first-message reaction you may use one " +
    "of these names, or a normal Unicode emoji):\n" +
    `${emojiList(ctx.emojis)}\n\n` +
    "Card background_type is \"color\" unless the user gives a real image URL, then \"url\" with " +
    "background_url set. When you enable an event, also give it a channel (join and leave) unless " +
    "the user said to keep the current one. When you turn on an embed, give it a title or " +
    "description. For cards and embeds, write the text and pick colors, layout and shape (keep " +
    "text readable against the background), but keep pixel sizes, offsets, border width/radius, " +
    "font sizes and ring width null unless the user asks for them. Leave anything the user didn't " +
    "mention null, even when you would pick the default.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the changes (leave question null)."
  );
}

export const welcomeWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 4000,
  buildResultSchema: buildWelcomeResultSchema,
  validateConfig: validateWelcomeConfig,
  buildSystemPrompt: buildWelcomePrompt,
};
