/**
 * Server Autopilot naming formatter. Turns a plain `base` ("general chat") plus an emoji into the
 * final Discord name for a channel, voice channel or category, following the walkthrough's naming
 * choices. The website mirrors this function exactly for its live previews, so keep it pure and
 * keep naming.test.ts as the shared source of truth when changing anything here.
 */
import { SA_LIMITS, type SAChannelType, type SANaming } from "./types.js";

export type SANameKind = SAChannelType | "category";

/** Characters stripped from every name (Discord forbids them in text channel names). */
const FORBIDDEN = /[#@:`]/gu;

/** Decorators that collapse together with an unused {emoji} token (one on each side). */
export const EMOJI_DECORATORS = ["｜", "|", "┃", "・", "·", "︲", "︰", ":", "»", "✦", "⋆", "╏", "⌇", "│", "「", "」", "꒰", "꒱", "【", "】"];
const DECORATOR_SET = new Set(EMOJI_DECORATORS);

/** Bracket pairs: when one half collapses with the emoji, its unmatched other half goes too. */
const BRACKET_PAIRS: Array<[string, string]> = [
  ["「", "」"],
  ["【", "】"],
  ["꒰", "꒱"],
];

/**
 * `channel_case` only affects voice/stage names (Discord lowercases text-like names anyway):
 * "as_is" uses `voice_case`, "lower" forces voice/stage names to lowercase too.
 */
export const DEFAULT_NAMING: SANaming = {
  channel_case: "as_is",
  separator: "-",
  channel_pattern: "{name}",
  category_pattern: "{name}",
  category_case: "upper",
  voice_pattern: "{name}",
  voice_case: "title",
  font: "normal",
  emoji_mode: "none",
};

/** Rule 1: plain lowercase words of a base name. */
export function nameWords(base: string): string[] {
  return base
    .replace(FORBIDDEN, "")
    .split(/[\s\-_]+/u)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

function titleCase(word: string): string {
  const [first = "", ...rest] = Array.from(word);
  return first.toUpperCase() + rest.join("");
}

function applyCase(words: string[], mode: "upper" | "title" | "lower"): string[] {
  if (mode === "upper") return words.map((w) => w.toUpperCase());
  if (mode === "title") return words.map(titleCase);
  return words.map((w) => w.toLowerCase());
}

// ── Fonts ───────────────────────────────────────────────────────────────────

const SMALL_CAPS: Record<string, string> = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ", j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ",
  n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ", s: "ꜱ", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
};

/** Mathematical alphanumeric blocks: [upper A, lower a, digit 0] code points (null = unchanged). */
const FONT_BASES: Record<"bold" | "italic" | "monospace" | "fullwidth", [number, number, number | null]> = {
  bold: [0x1d5d4, 0x1d5ee, 0x1d7ec], // sans-serif bold
  italic: [0x1d608, 0x1d622, null], // sans-serif italic
  monospace: [0x1d670, 0x1d68a, 0x1d7f6],
  fullwidth: [0xff21, 0xff41, 0xff10],
};

/** Maps ASCII letters/digits into a Unicode "font"; everything else is unchanged. */
export function applyFont(text: string, font: SANaming["font"]): string {
  if (font === "normal") return text;
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const isUpper = ch.length === 1 && code >= 65 && code <= 90;
    const isLower = ch.length === 1 && code >= 97 && code <= 122;
    const isDigit = ch.length === 1 && code >= 48 && code <= 57;
    if (font === "small_caps") {
      out += isUpper || isLower ? SMALL_CAPS[ch.toLowerCase()]! : ch;
      continue;
    }
    const [upper, lower, digit] = FONT_BASES[font];
    if (isUpper) out += String.fromCodePoint(upper + code - 65);
    else if (isLower) out += String.fromCodePoint(lower + code - 97);
    else if (isDigit && digit !== null) out += String.fromCodePoint(digit + code - 48);
    else out += ch;
  }
  return out;
}

// ── Pattern filling ─────────────────────────────────────────────────────────

/** Removes one `{emoji}` token with its adjacent whitespace and (one per side) decorator. */
function collapseEmojiToken(pattern: string): string {
  const index = pattern.indexOf("{emoji}");
  if (index < 0) return pattern;
  const left = Array.from(pattern.slice(0, index));
  const right = Array.from(pattern.slice(index + "{emoji}".length));
  let spaced = false;
  const removed: string[] = [];

  const trimEnd = () => {
    while (left.length && /\s/u.test(left[left.length - 1]!)) {
      left.pop();
      spaced = true;
    }
  };
  const trimStart = () => {
    while (right.length && /\s/u.test(right[0]!)) {
      right.shift();
      spaced = true;
    }
  };

  trimEnd();
  if (left.length && DECORATOR_SET.has(left[left.length - 1]!)) {
    removed.push(left.pop()!);
    trimEnd();
  }
  trimStart();
  if (right.length && DECORATOR_SET.has(right[0]!)) {
    removed.push(right.shift()!);
    trimStart();
  }

  // An opening bracket that collapsed takes its now-unmatched closing half with it (and back).
  for (const [open, close] of BRACKET_PAIRS) {
    if (removed.includes(open) && !removed.includes(close)) {
      const at = right.lastIndexOf(close);
      if (at >= 0) {
        right.splice(at, 1);
        // The closing half sat at the end: drop the space that led up to it.
        if (at === right.length) while (right.length && /\s/u.test(right[right.length - 1]!)) right.pop();
      }
    }
    if (removed.includes(close) && !removed.includes(open)) {
      const at = left.indexOf(open);
      if (at >= 0) {
        left.splice(at, 1);
        if (at === 0) while (left.length && /\s/u.test(left[0]!)) left.shift();
      }
    }
  }

  const joiner = spaced && left.length && right.length ? " " : "";
  return left.join("") + joiner + right.join("");
}

/**
 * Rule 3. Fills `{emoji}` (or collapses it when there's no emoji to show) and `{name}`.
 * Falls back to just the name when the result would be empty.
 */
export function fillPattern(pattern: string, name: string, emoji: string | null): string {
  let working = pattern;
  if (emoji) {
    working = working.split("{emoji}").join(emoji);
  } else {
    let guard = 0;
    while (working.includes("{emoji}") && guard++ < 10) working = collapseEmojiToken(working);
  }
  const result = working.split("{name}").join(name).trim();
  return result || name;
}

/** Rule 4: at most 100 code points, cut on a grapheme boundary (never splits an emoji). */
export function truncateName(name: string, max: number = SA_LIMITS.nameMax): string {
  if (Array.from(name).length <= max) return name;
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  let out = "";
  let count = 0;
  for (const { segment } of segmenter.segment(name)) {
    const size = Array.from(segment).length;
    if (count + size > max) break;
    out += segment;
    count += size;
  }
  return out.trim() || out;
}

function emojiAllowed(mode: SANaming["emoji_mode"], kind: SANameKind): boolean {
  if (mode === "all") return true;
  if (mode === "none") return false;
  return mode === "categories" ? kind === "category" : kind !== "category";
}

/** The final Discord name for one template item. */
export function formatName(naming: SANaming, kind: SANameKind, base: string, emoji: string): string {
  let words = nameWords(base);
  if (words.length === 0) words = [kind === "category" ? "category" : "channel"];
  const shownEmoji = emojiAllowed(naming.emoji_mode, kind) && emoji.trim() ? emoji.trim() : null;

  if (kind === "category") {
    const body = applyFont(applyCase(words, naming.category_case).join(" "), naming.font);
    return truncateName(fillPattern(naming.category_pattern, body, shownEmoji));
  }

  if (kind === "voice" || kind === "stage") {
    const mode = naming.channel_case === "lower" ? "lower" : naming.voice_case;
    const body = applyFont(applyCase(words, mode).join(" "), naming.font);
    return truncateName(fillPattern(naming.voice_pattern, body, shownEmoji));
  }

  // Text-like: Discord lowercases ASCII and turns spaces into dashes.
  const body = applyFont(words.join(naming.separator), naming.font);
  const filled = fillPattern(naming.channel_pattern, body, shownEmoji);
  const discordified = filled.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/\s+/gu, "-");
  return truncateName(discordified);
}

/** Pattern decoration (everything but the tokens) in code points. */
export function decorationLength(pattern: string): number {
  return Array.from(pattern.split("{name}").join("").split("{emoji}").join("")).length;
}

/** A pattern is usable when it contains {name} once and ≤ 30 characters of decoration. */
export function validPattern(pattern: string): boolean {
  return pattern.split("{name}").length === 2 && decorationLength(pattern) <= SA_LIMITS.decorationMax && !/[\n\r]/.test(pattern);
}

// ── Presets ─────────────────────────────────────────────────────────────────

export type SANamingPreset = { id: string; label: string; description: string; naming: SANaming };

const preset = (id: string, label: string, description: string, naming: Partial<SANaming>): SANamingPreset => ({
  id,
  label,
  description,
  naming: { ...DEFAULT_NAMING, ...naming },
});

export const NAMING_PRESETS: SANamingPreset[] = [
  preset("clean", "Clean", "Plain names, dashes between words.", { channel_pattern: "{name}", separator: "-", emoji_mode: "none" }),
  preset("emoji_bar", "Emoji bar", "An emoji and a thin bar before every name.", {
    channel_pattern: "{emoji}｜{name}",
    voice_pattern: "{emoji}｜{name}",
    category_pattern: "{emoji} {name}",
    emoji_mode: "all",
  }),
  preset("emoji_dot", "Emoji dot", "An emoji and a middle dot before every name.", {
    channel_pattern: "{emoji}・{name}",
    voice_pattern: "{emoji}・{name}",
    category_pattern: "{emoji} {name}",
    emoji_mode: "all",
  }),
  preset("brackets", "Brackets", "Emojis wrapped in corner brackets.", {
    channel_pattern: "「{emoji}」{name}",
    voice_pattern: "「{emoji}」{name}",
    category_pattern: "「{name}」",
    emoji_mode: "channels",
  }),
  preset("aesthetic", "Aesthetic", "Soft curls, small caps and dotted dividers.", {
    channel_pattern: "╭・{emoji}︰{name}",
    voice_pattern: "{emoji}︰{name}",
    category_pattern: "꒰ {emoji} ꒱ {name}",
    category_case: "lower",
    voice_case: "lower",
    font: "small_caps",
    emoji_mode: "all",
  }),
  preset("minimal_caps", "Minimal caps", "No decoration, UPPERCASE categories.", {
    channel_pattern: "{name}",
    category_pattern: "{name}",
    category_case: "upper",
    emoji_mode: "none",
  }),
  preset("lined", "Lined", "Categories framed by lines.", {
    channel_pattern: "{name}",
    category_pattern: "── {name} ──",
    category_case: "upper",
    emoji_mode: "none",
  }),
  preset("boxed", "Boxed", "Categories in heavy brackets with an emoji.", {
    channel_pattern: "{emoji}・{name}",
    voice_pattern: "{emoji} {name}",
    category_pattern: "【{emoji} {name}】",
    category_case: "upper",
    emoji_mode: "all",
  }),
  preset("stars", "Stars", "Sparkles around every category.", {
    channel_pattern: "{emoji}・{name}",
    voice_pattern: "{emoji} {name}",
    category_pattern: "✦ {name} ✦",
    category_case: "upper",
    emoji_mode: "channels",
  }),
  preset("cozy", "Cozy", "Emoji first, soft dividers between words.", {
    channel_pattern: "{emoji} {name}",
    voice_pattern: "{emoji} {name}",
    category_pattern: "{emoji} {name}",
    separator: "︲",
    category_case: "title",
    emoji_mode: "all",
  }),
  preset("gamer", "Gamer", "Bold bars around the emoji.", {
    channel_pattern: "┃{emoji}┃{name}",
    voice_pattern: "┃{emoji}┃{name}",
    category_pattern: "▬ {name} ▬",
    category_case: "upper",
    emoji_mode: "channels",
  }),
  preset("professional", "Professional", "Clear and plain, Title Case categories, no emoji.", {
    channel_pattern: "{name}",
    separator: "-",
    category_pattern: "{name}",
    category_case: "title",
    voice_pattern: "{name}",
    emoji_mode: "none",
  }),
];

export function namingPreset(id: string): SANamingPreset | null {
  return NAMING_PRESETS.find((p) => p.id === id) ?? null;
}

/** The preset whose naming matches exactly (ignoring nothing), else null. */
export function matchNamingPreset(naming: Partial<SANaming>): string | null {
  const keys: (keyof SANaming)[] = ["channel_pattern", "category_pattern", "voice_pattern", "category_case", "separator", "font", "emoji_mode"];
  let best: { id: string; score: number } | null = null;
  for (const p of NAMING_PRESETS) {
    let score = 0;
    let conflict = false;
    for (const key of keys) {
      if (naming[key] === undefined) continue;
      if (naming[key] === p.naming[key]) score += 1;
      else if (key === "channel_pattern" || key === "category_pattern") conflict = true;
    }
    if (!conflict && score >= 2 && (!best || score > best.score)) best = { id: p.id, score };
  }
  return best?.id ?? null;
}
