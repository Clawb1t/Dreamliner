/**
 * Server Autopilot heuristics over an existing server: what an existing channel is for (so merge
 * can reuse it), name normalisation for matching, and the naming style a server already uses.
 * Pure: works on plain names, no discord.js.
 */
import { DEFAULT_NAMING, EMOJI_DECORATORS, matchNamingPreset } from "./naming.js";
import type { SANaming, SAPurpose, SARolePreset } from "./types.js";

const PICTO = /\p{Extended_Pictographic}/u;
const SMALL_CAPS_CHARS = /[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ]/u;

/** Folds Unicode "fonts" (math bold/italic/monospace, fullwidth, small caps) back to ASCII. */
export function unfont(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1d400 && cp <= 0x1d6a3) {
      const offset = (cp - 0x1d400) % 52;
      out += offset < 26 ? String.fromCharCode(65 + offset) : String.fromCharCode(97 + offset - 26);
    } else if (cp >= 0x1d7ce && cp <= 0x1d7ff) {
      out += String.fromCharCode(48 + ((cp - 0x1d7ce) % 10));
    } else if (cp >= 0xff21 && cp <= 0xff3a) out += String.fromCharCode(cp - 0xff21 + 65);
    else if (cp >= 0xff41 && cp <= 0xff5a) out += String.fromCharCode(cp - 0xff41 + 97);
    else if (cp >= 0xff10 && cp <= 0xff19) out += String.fromCharCode(cp - 0xff10 + 48);
    else {
      const small = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ".indexOf(ch);
      out += small >= 0 && ch !== "x" ? String.fromCharCode(97 + small) : ch;
    }
  }
  return out;
}

/** A comparable form of any name: unfonted, lowercase letters and digits only. */
export function normalizeName(name: string): string {
  return unfont(name)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Purpose keywords, matched against the normalised name words (first match wins). */
const PURPOSE_KEYWORDS: Array<[SAPurpose, RegExp]> = [
  ["rules", /^(rules?|regeln|reglas?|regles|regras|server ?rules|guidelines|tos)$/],
  ["announcements", /^(announcements?|announce|news|ankuendigungen|anuncios)$/],
  ["updates", /^(updates?|changelog|patch ?notes|releases?)$/],
  ["welcome", /^(welcome|willkommen|bienvenid[ao]s?|bienvenue|arrivals?|joins?)$/],
  ["introductions", /^(intro(duction)?s?|introduce ?yourself|vorstellung(en)?|presentaciones)$/],
  ["verify", /^(verif(y|ication)|verify ?here|gate)$/],
  ["roles", /^((self ?)?roles?|role ?select(ion)?|get ?roles|pick ?roles|reaction ?roles)$/],
  ["faq", /^(faq|questions|help ?faq)$/],
  ["general", /^(general|chat|main( chat)?|lobby|lounge|allgemein|general ?chat|talk)$/],
  ["off_topic", /^(off ?topic|random|misc|offtopic)$/],
  ["memes", /^(memes?|shitposts?)$/],
  ["media", /^(media|pics|photos|images|selfies|screenshots)$/],
  ["art", /^(art|artwork|fan ?art|drawings|creations)$/],
  ["clips", /^(clips|highlights|videos)$/],
  ["events", /^(events?)$/],
  ["giveaways", /^(giveaways?)$/],
  ["polls", /^(polls?|votes?)$/],
  ["suggestions", /^(suggestions?|ideas|feedback)$/],
  ["tickets", /^(tickets?|support|help|create ?ticket|help ?desk)$/],
  ["starboard", /^(starboard|hall ?of ?fame|best ?of)$/],
  ["counting", /^(counting|count)$/],
  ["bot_commands", /^(bot ?commands?|commands|bots?|bot ?spam|cmds)$/],
  ["music", /^(music|music ?commands|song ?requests)$/],
  ["lfg", /^(lfg|looking ?for ?(group|game)|team ?finder)$/],
  ["self_promo", /^(self ?promo(tion)?|promo|advertis(e|ing)|shameless ?plugs)$/],
  ["partners", /^(partners?|partnerships?|affiliates?)$/],
  ["resources", /^(resources?|guides?|tutorials?|docs)$/],
  ["links", /^(links?|socials?)$/],
  ["birthdays", /^(birthdays?)$/],
  ["leveling", /^(level(ing|s)?|level ?ups?|xp|ranks?)$/],
  ["qotd", /^(qotd|question ?of ?the ?day)$/],
  ["staff_chat", /^(staff( chat)?|mod ?chat|mods?|moderators?|admin( chat)?|team ?chat)$/],
  ["mod_logs", /^(mod ?logs?|moderation ?logs?|audit ?logs?|punishments)$/],
  ["logs", /^(logs?|server ?logs?|message ?logs?|join ?logs?)$/],
  ["afk", /^(afk|away)$/],
  ["stage", /^(stage|podium|town ?hall)$/],
  ["voice_music", /^(music ?(vc|voice)|vc ?music|radio)$/],
  ["voice_gaming", /^(gaming ?(vc|voice)?|game ?(vc|voice|room))$/],
  ["voice_study", /^(study ?(room|vc|hall)?|focus|co ?working)$/],
  ["voice_lounge", /^(lounge|general ?(vc|voice)|vc|voice|hangout|chill ?(vc|zone)?)$/],
];

/** Words of a name with decoration, emoji and fonts removed: "📜︱server-rules" → "server rules". */
export function plainWords(name: string): string {
  return unfont(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** What an existing channel is for, from its name (and topic, weakly). "other" when unsure. */
export function detectPurpose(name: string, kind: "text" | "voice" | "forum" | "stage" | "announcement" | "other" | "category", topic = ""): SAPurpose {
  const words = plainWords(name);
  const voice = kind === "voice" || kind === "stage";
  if (kind === "stage") return "stage";
  for (const [purpose, re] of PURPOSE_KEYWORDS) {
    if (!re.test(words)) continue;
    const isVoicePurpose = purpose.startsWith("voice_") || purpose === "afk" || purpose === "stage";
    if (voice && !isVoicePurpose) {
      if (purpose === "general") return "voice_lounge";
      if (purpose === "music") return "voice_music";
      continue;
    }
    if (!voice && isVoicePurpose) continue;
    return purpose;
  }
  if (voice) return "other";
  const topicWords = plainWords(topic);
  if (/\b(rules|guidelines)\b/.test(topicWords) && /\bread\b/.test(topicWords)) return "rules";
  return "other";
}

// Words that mark a staff-side channel, whatever purpose the template gave it.
const SENSITIVE_WORDS = new Set([
  "staff", "moderator", "moderators", "moderation", "admin", "admins", "administrator", "administrators", "administration",
  "management", "managers", "leadership", "council", "audit", "internal", "private", "owners", "executive", "exec",
  "punishments", "infractions", "warnings", "modmail", "evidence",
]);
// Only private next to one of these: "mods" alone is often game mods, "logs" alone may be devlogs.
const MOD_WORDS = new Set(["mod", "mods"]);
const MOD_COMPANIONS = new Set(["chat", "talk", "lounge", "only", "team", "log", "logs", "room", "area", "hq", "discussion", "general", "queue", "actions", "notes"]);
const LOG_WORDS = new Set(["log", "logs", "logging"]);
const PUBLIC_LOG_PREFIXES = new Set(["dev", "patch", "change", "update", "release", "game", "build", "captain", "quest"]);
// Staff words that describe a public channel: applying to staff, meeting or listing the team.
const PUBLIC_STAFF_WORDS = new Set(["apply", "applications", "application", "apps", "hiring", "recruitment", "recruiting", "list", "roster", "meet", "contact", "info", "introductions"]);

/**
 * Whether a channel or category name says it's for staff only (mod chat, logs, admin area…), so it
 * must never be public. Conservative on purpose: when unsure, hiding a channel is the safe mistake.
 */
export function isSensitiveName(name: string): boolean {
  const words = plainWords(name).split(" ").filter(Boolean);
  if (!words.length) return false;
  if (words.some((w) => PUBLIC_STAFF_WORDS.has(w))) return false;
  // A bare "mods" reads as moderators to detectPurpose, but in a template it's as likely game mods;
  // the template's own purpose (staff_chat) still hides it when that's what it is.
  const purpose = words.every((w) => MOD_WORDS.has(w)) ? "other" : detectPurpose(name, "text");
  if (purpose === "staff_chat" || purpose === "mod_logs") return true;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    if (SENSITIVE_WORDS.has(w)) return true;
    if (MOD_WORDS.has(w) && words.some((other, j) => j !== i && MOD_COMPANIONS.has(other))) return true;
    if (LOG_WORDS.has(w) && !(i > 0 && PUBLIC_LOG_PREFIXES.has(words[i - 1]!))) return true;
    if (/^(mod|staff|admin|audit)logs?$/.test(w)) return true;
  }
  return false;
}

/** Role presets an existing role name suggests (for merge matching). */
const ROLE_SYNONYMS: Array<[SARolePreset, RegExp]> = [
  ["owner", /^(owner|founder|server ?owner|co ?owner|creator)$/],
  ["admin", /^(admins?|administrators?|head ?admin)$/],
  ["moderator", /^(mods?|moderators?|moderation|head ?mod)$/],
  ["helper", /^(helpers?|trial ?mods?|support|supporters? ?team)$/],
  ["staff", /^(staff|team|crew)$/],
  ["verified", /^(verified|verified ?members?)$/],
  ["member", /^(members?|community|citizens?)$/],
  ["muted", /^(muted|mute|silenced)$/],
  ["vip", /^(vips?|very ?important)$/],
  ["bot", /^(bots?)$/],
];

export function detectRolePreset(name: string): SARolePreset | null {
  const words = plainWords(name);
  for (const [preset, re] of ROLE_SYNONYMS) if (re.test(words)) return preset;
  return null;
}

// ── Naming style ────────────────────────────────────────────────────────────

const DECORATOR_LIST = [...EMOJI_DECORATORS, "︱", "丨", "┊", "⁠", "•", "→", "⟩", ">", "-", "_", "~", "|"];

type Analysed = { emoji: string | null; decorator: string; rest: string };

function leadingGrapheme(name: string): string {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(name)) return segment;
  return "";
}

/** Splits "🎮︱gaming-chat" into emoji "🎮", decorator "︱", rest "gaming-chat". */
function analyse(name: string): Analysed {
  let rest = name.trim();
  let emoji: string | null = null;
  let decorator = "";
  const first = leadingGrapheme(rest);
  if (first && PICTO.test(first)) {
    emoji = first;
    rest = rest.slice(first.length);
  }
  const chars = Array.from(rest);
  let i = 0;
  while (i < chars.length && (DECORATOR_LIST.includes(chars[i]!) || /\s/u.test(chars[i]!))) {
    decorator += chars[i];
    i += 1;
  }
  return { emoji, decorator: decorator.trim() || (decorator ? " " : ""), rest: chars.slice(i).join("") };
}

function mostCommon<T>(values: T[]): { value: T; share: number } | null {
  if (!values.length) return null;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T = values[0]!;
  for (const [v, n] of counts) if (n > (counts.get(best) ?? 0)) best = v;
  return { value: best, share: (counts.get(best) ?? 0) / values.length };
}

export type DetectedNaming = { naming: Partial<SANaming>; preset: string | null; summary: string };

/**
 * Reads the naming style a server already uses from its channel and category names: emoji
 * prefixes and the divider after them, word separators, category casing and frames, fonts.
 */
export function detectNaming(input: { text: string[]; voice: string[]; categories: string[] }): DetectedNaming {
  const naming: Partial<SANaming> = {};
  const notes: string[] = [];
  const text = input.text.filter(Boolean);
  const voice = input.voice.filter(Boolean);
  const categories = input.categories.filter(Boolean);

  // Text channels: emoji prefix + divider.
  const textParts = text.map(analyse);
  const emojiShare = textParts.length ? textParts.filter((p) => p.emoji).length / textParts.length : 0;
  let channelEmoji = false;
  if (emojiShare >= 0.5) {
    channelEmoji = true;
    const divider = mostCommon(textParts.filter((p) => p.emoji).map((p) => p.decorator));
    const dec = divider && divider.share >= 0.5 ? divider.value : "";
    // Discord turns a space after the emoji into "-", so both read back as "{emoji} {name}".
    naming.channel_pattern = dec === " " || dec === "-" ? "{emoji} {name}" : `{emoji}${dec}{name}`;
    notes.push(dec && dec !== " " && dec !== "-" ? `Uses emoji + ${dec} prefixes` : "Uses emoji prefixes");
  } else if (textParts.length) {
    naming.channel_pattern = "{name}";
    notes.push("Plain channel names");
  }

  // Word separator inside the rest of text channel names.
  const seps: string[] = [];
  for (const p of textParts) {
    const rest = p.rest;
    if (rest.includes("・")) seps.push("・");
    else if (rest.includes("·")) seps.push("·");
    else if (rest.includes("︲")) seps.push("︲");
    else if (rest.includes("_")) seps.push("_");
    else if (rest.includes("-")) seps.push("-");
  }
  const sep = mostCommon(seps);
  if (sep && sep.share >= 0.5) naming.separator = sep.value as SANaming["separator"];
  else if (textParts.length) naming.separator = "-";

  // Fonts.
  const all = [...text, ...voice, ...categories].join(" ");
  if (SMALL_CAPS_CHARS.test(all) && (all.match(new RegExp(SMALL_CAPS_CHARS, "gu"))?.length ?? 0) >= 6) {
    naming.font = "small_caps";
    notes.push("small caps letters");
  } else if (/[\u{1D5EE}-\u{1D607}]/u.test(all)) naming.font = "bold";
  else if (/[\u{1D68A}-\u{1D6A3}]/u.test(all)) naming.font = "monospace";
  else if (/[ａ-ｚ]/u.test(all)) naming.font = "fullwidth";
  else if (all) naming.font = "normal";

  // Voice channels.
  const voiceParts = voice.map(analyse);
  let voiceEmoji = false;
  if (voiceParts.length) {
    const share = voiceParts.filter((p) => p.emoji).length / voiceParts.length;
    if (share >= 0.5) {
      voiceEmoji = true;
      const divider = mostCommon(voiceParts.filter((p) => p.emoji).map((p) => p.decorator));
      const dec = divider && divider.share >= 0.5 && divider.value !== " " ? divider.value : " ";
      naming.voice_pattern = dec === " " ? "{emoji} {name}" : `{emoji}${dec}{name}`;
    } else naming.voice_pattern = "{name}";
    const letters = voiceParts.map((p) => unfont(p.rest).replace(/[^A-Za-z]/g, "")).filter(Boolean);
    if (letters.length) {
      if (letters.every((l) => l === l.toUpperCase())) naming.voice_case = "upper";
      else if (letters.every((l) => l === l.toLowerCase())) naming.voice_case = "lower";
      else naming.voice_case = "title";
    }
  }

  // Categories: casing, frames, emoji.
  let categoryEmoji = false;
  if (categories.length) {
    const letters = categories.map((c) => unfont(c).replace(/[^A-Za-z]/g, "")).filter(Boolean);
    if (letters.length) {
      if (letters.every((l) => l === l.toUpperCase())) {
        naming.category_case = "upper";
        notes.push("UPPERCASE categories");
      } else if (letters.every((l) => l === l.toLowerCase())) {
        naming.category_case = "lower";
        notes.push("lowercase categories");
      } else naming.category_case = "title";
    }
    const frames: Array<[RegExp, string, string]> = [
      [/^[─━—–-]{2,}\s*.+\s*[─━—–-]{2,}$/u, "── {name} ──", "line-framed categories"],
      [/^【.+】$/u, "【{emoji} {name}】", "【boxed】 categories"],
      [/^✦.+✦$/u, "✦ {name} ✦", "✦ starred ✦ categories"],
      [/^⌜.+⌟$/u, "⌜{name}⌟", "⌜cornered⌟ categories"],
      [/^「.+」$/u, "「{name}」", "「bracketed」 categories"],
      [/^꒰.+꒱/u, "꒰ {emoji} ꒱ {name}", "꒰ curly ꒱ categories"],
      [/^▬.+▬$/u, "▬ {name} ▬", "barred categories"],
    ];
    for (const [re, pattern, note] of frames) {
      const share = categories.filter((c) => re.test(c.trim())).length / categories.length;
      if (share >= 0.5) {
        naming.category_pattern = pattern;
        notes.push(note);
        break;
      }
    }
    const catEmojiShare = categories.filter((c) => {
      const inner = c.replace(/^[【「꒰⌜✦\s]+/u, "");
      return PICTO.test(leadingGrapheme(inner));
    }).length / categories.length;
    if (catEmojiShare >= 0.5) {
      categoryEmoji = true;
      if (!naming.category_pattern) naming.category_pattern = "{emoji} {name}";
    } else if (!naming.category_pattern) naming.category_pattern = "{name}";
  }

  if (channelEmoji || voiceEmoji || categoryEmoji) {
    naming.emoji_mode =
      (channelEmoji || voiceEmoji) && categoryEmoji ? "all" : categoryEmoji ? "categories" : "channels";
  } else if (text.length || categories.length) naming.emoji_mode = "none";

  if (!text.length && !voice.length && !categories.length) {
    return { naming: {}, preset: null, summary: "This server has no channels yet." };
  }
  naming.channel_case = DEFAULT_NAMING.channel_case;
  const summary = notes.length ? `${notes[0]!.charAt(0).toUpperCase()}${notes[0]!.slice(1)}${notes.length > 1 ? `, ${notes.slice(1).join(", ")}` : ""}` : "Plain names";
  return { naming, preset: matchNamingPreset(naming), summary };
}
