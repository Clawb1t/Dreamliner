/**
 * Server Autopilot walkthrough answers (`SAAnswers`). Every field is optional with a default and
 * the schema is forgiving (unknown enum values are dropped, too-long text is cut), so a slightly
 * older or newer website never blocks a generation.
 */
import { z } from "zod";
import { DEFAULT_NAMING, validPattern } from "./naming.js";
import {
  SA_AGES,
  SA_CATEGORY_CASES,
  SA_CHANNEL_CASES,
  SA_EMOJI_MODES,
  SA_FEATURES,
  SA_FONTS,
  SA_MEMBER_ROLES,
  SA_MESSAGE_KINDS,
  SA_MESSAGE_TONES,
  SA_MODES,
  SA_MOODS,
  SA_PALETTES,
  SA_PLUGINS,
  SA_ROLE_STYLES,
  SA_SELF_ROLES,
  SA_SEPARATORS,
  SA_SERVER_TYPES,
  SA_SIZES,
  SA_STAFF_ROLES,
  SA_STRICTNESS,
  SA_VERIFICATION,
  SA_VOICE_AMOUNTS,
  SA_VOICE_CASES,
  type SANaming,
} from "./types.js";

const text = (max: number, fallback = "") =>
  z
    .unknown()
    .transform((v) => (typeof v === "string" ? v.trim().slice(0, max) : fallback))
    .default(fallback);

const choice = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z
    .unknown()
    .transform((v): T[number] => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T[number]) : fallback))
    .default(fallback);

const choices = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number][] = []) =>
  z
    .unknown()
    .transform((v): T[number][] =>
      Array.isArray(v) ? [...new Set(v.filter((x): x is T[number] => typeof x === "string" && (values as readonly string[]).includes(x)))] : fallback,
    )
    .default(fallback);

const flag = (fallback: boolean) =>
  z
    .unknown()
    .transform((v) => (typeof v === "boolean" ? v : fallback))
    .default(fallback);

const pattern = (fallback: string) =>
  z
    .unknown()
    .transform((v) => (typeof v === "string" && validPattern(v.trim()) ? v.trim() : fallback))
    .default(fallback);

const snowflakes = z
  .unknown()
  .transform((v) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && /^\d{15,25}$/.test(x)))].slice(0, 200) : []))
  .default([]);

export const zNaming = z
  .object({
    channel_case: choice(SA_CHANNEL_CASES, DEFAULT_NAMING.channel_case),
    separator: choice(SA_SEPARATORS as unknown as readonly [string, ...string[]], DEFAULT_NAMING.separator) as unknown as z.ZodType<SANaming["separator"]>,
    channel_pattern: pattern(DEFAULT_NAMING.channel_pattern),
    category_pattern: pattern(DEFAULT_NAMING.category_pattern),
    category_case: choice(SA_CATEGORY_CASES, DEFAULT_NAMING.category_case),
    voice_pattern: pattern(DEFAULT_NAMING.voice_pattern),
    voice_case: choice(SA_VOICE_CASES, DEFAULT_NAMING.voice_case),
    font: choice(SA_FONTS, DEFAULT_NAMING.font),
    emoji_mode: choice(SA_EMOJI_MODES, DEFAULT_NAMING.emoji_mode),
  })
  .catch({ ...DEFAULT_NAMING });

const obj = <S extends z.ZodRawShape>(shape: S) =>
  z.preprocess((v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}), z.object(shape)).default({});

export const zAnswers = obj({
  basics: obj({
    server_name: text(100),
    type: choice(SA_SERVER_TYPES, "community"),
    type_custom: text(100),
    description: text(500),
    language: text(40, "English"),
  }),
  audience: obj({
    size: choice(SA_SIZES, "small"),
    age: choice(SA_AGES, "13plus"),
    region: text(80),
  }),
  vibe: obj({
    mood: choices(SA_MOODS),
    palette: choice(SA_PALETTES, "auto"),
    brand_color: z
      .unknown()
      .transform((v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : null))
      .default(null),
  }),
  naming: z
    .preprocess(
      (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
      z.object({
        preset: text(40, "clean"),
        let_ai_pick_emoji: flag(true),
      }).passthrough(),
    )
    .default({})
    .transform((v) => ({ ...zNaming.parse(v), preset: v.preset || "clean", let_ai_pick_emoji: v.let_ai_pick_emoji })),
  features: choices(SA_FEATURES, ["rules", "announcements", "welcome", "general_chat", "media", "bot_commands", "staff_area"]),
  feature_notes: text(500),
  voice: obj({
    amount: choice(SA_VOICE_AMOUNTS, "some"),
    lounges: flag(true),
    gaming: flag(false),
    music: flag(false),
    study: flag(false),
    afk: flag(false),
    stage: flag(false),
    private_rooms: flag(false),
  }),
  roles: obj({
    staff: choices(SA_STAFF_ROLES, ["admin", "moderator"]),
    member: choices(SA_MEMBER_ROLES, ["member"]),
    self_roles: choices(SA_SELF_ROLES, ["pings"]),
    custom: text(300),
    role_style: choice(SA_ROLE_STYLES, "plain"),
  }),
  moderation: obj({
    strictness: choice(SA_STRICTNESS, "standard"),
    verification: choice(SA_VERIFICATION, "none"),
    slowmode_busy_channels: flag(false),
    nsfw_allowed: flag(false),
    read_only_info: flag(true),
  }),
  plugins: obj({
    wanted: choices(SA_PLUGINS, ["welcome_message", "logs", "automod"]),
    auto: flag(true),
  }),
  messages: obj({
    wanted: choices(SA_MESSAGE_KINDS, ["rules", "welcome_info"]),
    tone: choice(SA_MESSAGE_TONES, "friendly"),
  }),
  existing: obj({
    mode: choice(SA_MODES, "merge"),
    keep_channel_ids: snowflakes,
    keep_role_ids: snowflakes,
    reuse_style: flag(false),
  }),
  notes: text(1000),
});

export type SAAnswers = z.output<typeof zAnswers>;

export function parseAnswers(input: unknown): SAAnswers {
  return zAnswers.parse(input ?? {});
}

/** The naming part of the answers, without the walkthrough-only fields. */
export function namingOf(answers: SAAnswers): SANaming {
  const { preset: _preset, let_ai_pick_emoji: _pick, ...naming } = answers.naming;
  return naming;
}

/** The AI may restyle naming only when the manager picked "let Autopilot pick". */
export function aiMayPickNaming(answers: SAAnswers): boolean {
  return answers.naming.preset === "auto";
}
