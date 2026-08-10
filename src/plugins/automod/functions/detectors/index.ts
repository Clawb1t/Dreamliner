import { checkRateLimit } from "../../../../core/rules.js";
import type { AutomodRuleId } from "../../../../config/schemas/automod.js";
import { PROFANITY_WORDS } from "../packs/profanity.js";
import { SLUR_WORDS } from "../packs/slurs.js";
import { matchCustomFilter, parseFilterEntries } from "../customFilter.js";
import {
  normalizeForMatch,
  numSetting,
  sensitivityMultiplier,
  type AutomodHit,
  type AutomodMessageContext,
  type Detector,
} from "./types.js";
import { matchWordPack } from "./wordMatch.js";

const MESSAGE_RULE_ORDER: AutomodRuleId[] = [
  "slurs",
  "custom_filter",
  "profanity",
  "excessive_swearing",
  "everyone_here",
  "mass_mentions",
  "invites",
  "links",
  "spam",
  "emoji_spam",
  "duplicate",
  "copypasta",
  "sticker_gif_spam",
  "attachment_spam",
  "newline_spam",
  "wall_of_text",
  "repeated_chars",
  "excessive_caps",
  "zalgo",
];

function asMessage(ctx: Parameters<Detector>[0]): AutomodMessageContext | null {
  return ctx.kind === "message" ? ctx : null;
}

const detectProfanity: Detector = (ctx) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const hits = matchWordPack(msg.content, PROFANITY_WORDS);
  if (!hits.length) return null;
  return { ruleId: "profanity", reason: "Profanity detected", detail: hits.slice(0, 3).join(", ") };
};

const detectSlurs: Detector = (ctx) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const hits = matchWordPack(msg.content, SLUR_WORDS);
  if (!hits.length) return null;
  return { ruleId: "slurs", reason: "Slur detected", detail: hits[0] };
};

const detectExcessiveSwearing: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const hits = matchWordPack(msg.content, PROFANITY_WORDS);
  const min = Math.max(2, Math.round(numSetting(rule, "min_words", 3) * sensitivityMultiplier(rule)));
  if (hits.length < min) return null;
  return {
    ruleId: "excessive_swearing",
    reason: "Excessive swearing",
    detail: `${hits.length} swear words`,
  };
};

const detectCustomFilter: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const match = matchCustomFilter(msg.content, parseFilterEntries(rule.settings));
  if (!match) return null;
  return {
    ruleId: "custom_filter",
    reason: "Custom filter match",
    detail: match.pattern.slice(0, 40),
  };
};

const detectSpam: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg?.message.guild) return null;
  const mult = sensitivityMultiplier(rule);
  const count = Math.max(2, Math.round(numSetting(rule, "count", 5) * mult));
  const windowMs = numSetting(rule, "window_ms", 10_000);
  const key = `${msg.message.guild.id}:${msg.message.author.id}:${msg.message.channel.id}:spam`;
  if (!checkRateLimit(key, count, windowMs)) return null;
  return { ruleId: "spam", reason: "Message spam", detail: `${count}+ messages / ${Math.round(windowMs / 1000)}s` };
};

const detectEmojiSpam: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const custom = msg.content.match(/<a?:\w+:\d+>/g)?.length ?? 0;
  const unicode = [...msg.content].filter((ch) => /\p{Extended_Pictographic}/u.test(ch)).length;
  const total = custom + unicode;
  const max = Math.max(3, Math.round(numSetting(rule, "max_emoji", 8) * sensitivityMultiplier(rule)));
  if (total < max) return null;
  return { ruleId: "emoji_spam", reason: "Emoji spam", detail: `${total} emoji` };
};

const detectDuplicate: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg?.message.guild || !msg.normalized) return null;
  const max = Math.max(2, Math.round(numSetting(rule, "max", 3) * sensitivityMultiplier(rule)));
  const windowMs = numSetting(rule, "window_ms", 30_000);
  const key = `${msg.message.guild.id}:${msg.message.author.id}:${msg.message.channel.id}:dup:${msg.normalized}`;
  if (!checkRateLimit(key, max, windowMs)) return null;
  return { ruleId: "duplicate", reason: "Duplicate message spam" };
};

const detectCopypasta: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg?.message.guild || msg.normalized.length < 20) return null;
  const max = Math.max(2, Math.round(numSetting(rule, "max", 3) * sensitivityMultiplier(rule)));
  const windowMs = numSetting(rule, "window_ms", 60_000);
  const key = `${msg.message.guild.id}:copypasta:${msg.normalized.slice(0, 120)}`;
  if (!checkRateLimit(key, max, windowMs)) return null;
  return { ruleId: "copypasta", reason: "Copypasta detected" };
};

const detectStickerGifSpam: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg?.message.guild) return null;
  const stickers = msg.message.stickers?.size ?? 0;
  const hasGifAttach = msg.message.attachments.some(
    (a) =>
      (a.contentType?.includes("gif") ?? false) ||
      a.name?.toLowerCase().endsWith(".gif") ||
      a.name?.toLowerCase().endsWith(".webp"),
  );
  const hasGifEmbed = msg.message.embeds.some((e) => {
    const url = `${e.url ?? ""} ${e.provider?.name ?? ""} ${e.thumbnail?.url ?? ""}`.toLowerCase();
    return url.includes("tenor") || url.includes("giphy") || url.includes(".gif");
  });
  if (!stickers && !hasGifAttach && !hasGifEmbed) return null;
  const max = Math.max(2, Math.round(numSetting(rule, "count", 3) * sensitivityMultiplier(rule)));
  const windowMs = numSetting(rule, "window_ms", 15_000);
  const key = `${msg.message.guild.id}:${msg.message.author.id}:sticker_gif`;
  if (!checkRateLimit(key, max, windowMs)) return null;
  return { ruleId: "sticker_gif_spam", reason: "Sticker / GIF spam" };
};

const detectAttachmentSpam: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg?.message.guild || msg.message.attachments.size === 0) return null;
  const max = Math.max(2, Math.round(numSetting(rule, "count", 3) * sensitivityMultiplier(rule)));
  const windowMs = numSetting(rule, "window_ms", 20_000);
  const key = `${msg.message.guild.id}:${msg.message.author.id}:attach`;
  if (!checkRateLimit(key, max, windowMs)) return null;
  return { ruleId: "attachment_spam", reason: "Attachment spam" };
};

const detectNewlineSpam: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const lines = (msg.content.match(/\n/g) ?? []).length;
  const max = Math.max(4, Math.round(numSetting(rule, "max_newlines", 12) * sensitivityMultiplier(rule)));
  if (lines < max) return null;
  return { ruleId: "newline_spam", reason: "Newline spam", detail: `${lines} line breaks` };
};

const detectWallOfText: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const max = Math.max(200, Math.round(numSetting(rule, "max_chars", 1200) * sensitivityMultiplier(rule)));
  if (msg.content.length < max) return null;
  return { ruleId: "wall_of_text", reason: "Wall of text", detail: `${msg.content.length} characters` };
};

const detectRepeatedChars: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg?.content) return null;
  const max = Math.max(5, Math.round(numSetting(rule, "max_repeat", 8) * sensitivityMultiplier(rule)));
  const re = new RegExp(`(.)\\1{${max - 1},}`);
  if (!re.test(msg.content)) return null;
  return { ruleId: "repeated_chars", reason: "Repeated character flood" };
};

const detectMassMentions: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const unique = new Set(msg.message.mentions.users.keys()).size;
  const max = Math.max(3, Math.round(numSetting(rule, "max_mentions", 5) * sensitivityMultiplier(rule)));
  if (unique < max) return null;
  return { ruleId: "mass_mentions", reason: "Mass mentions", detail: `${unique} users` };
};

const detectEveryoneHere: Detector = (ctx) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  if (!msg.message.mentions.everyone && !msg.content.includes("@here") && !msg.content.includes("@everyone")) {
    return null;
  }
  // Allow if member has permission to mention everyone
  if (msg.member?.permissions?.has("MentionEveryone")) return null;
  if (msg.message.mentions.everyone || /@everyone|@here/i.test(msg.content)) {
    return { ruleId: "everyone_here", reason: "Unauthorized @everyone / @here" };
  }
  return null;
};

const INVITE_RE = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;

const detectInvites: Detector = (ctx) => {
  const msg = asMessage(ctx);
  if (!msg?.content) return null;
  if (!INVITE_RE.test(msg.content)) return null;
  return { ruleId: "invites", reason: "Discord invite link" };
};

const URL_RE = /https?:\/\/[^\s<>]+/gi;

const detectLinks: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg?.content) return null;
  const urls = msg.content.match(URL_RE) ?? [];
  if (!urls.length) return null;
  const blocked = Array.isArray(rule.settings.blocked_domains)
    ? (rule.settings.blocked_domains as string[]).map((d) => d.toLowerCase())
    : [];
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (blocked.some((d) => host === d || host.endsWith(`.${d}`))) {
        return { ruleId: "links", reason: "Blocked domain", detail: host };
      }
    } catch {
      /* ignore */
    }
  }
  const max = Math.max(2, Math.round(numSetting(rule, "max_links", 4) * sensitivityMultiplier(rule)));
  if (urls.length < max) return null;
  return { ruleId: "links", reason: "Link spam", detail: `${urls.length} links` };
};

const detectExcessiveCaps: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg) return null;
  const letters = msg.content.replace(/[^a-zA-Z]/g, "");
  const minLen = Math.max(6, Math.round(numSetting(rule, "min_length", 8) * sensitivityMultiplier(rule)));
  if (letters.length < minLen) return null;
  const caps = letters.replace(/[^A-Z]/g, "").length;
  const percent = (caps / letters.length) * 100;
  const maxPercent = Math.min(95, numSetting(rule, "max_percent", 70) * sensitivityMultiplier(rule));
  if (percent < maxPercent) return null;
  return { ruleId: "excessive_caps", reason: "Excessive caps", detail: `${Math.round(percent)}% caps` };
};

const detectZalgo: Detector = (ctx, rule) => {
  const msg = asMessage(ctx);
  if (!msg?.content) return null;
  const marks = (msg.content.match(/\p{M}/gu) ?? []).length;
  const max = Math.max(4, Math.round(numSetting(rule, "max_marks", 8) * sensitivityMultiplier(rule)));
  if (marks < max) return null;
  return { ruleId: "zalgo", reason: "Zalgo / obfuscated text", detail: `${marks} combining marks` };
};

const detectRaid: Detector = (ctx, rule) => {
  if (ctx.kind !== "join") return null;
  const count = Math.max(2, Math.round(numSetting(rule, "join_count", 10) * sensitivityMultiplier(rule)));
  const windowMs = numSetting(rule, "join_window_ms", 30_000);
  const key = `${ctx.member.guild.id}:raid`;
  if (!checkRateLimit(key, count, windowMs)) return null;
  return { ruleId: "raid", reason: "Raid join burst", detail: `${count}+ joins / ${Math.round(windowMs / 1000)}s` };
};

const DETECTORS: Record<AutomodRuleId, Detector> = {
  profanity: detectProfanity,
  slurs: detectSlurs,
  excessive_swearing: detectExcessiveSwearing,
  custom_filter: detectCustomFilter,
  spam: detectSpam,
  emoji_spam: detectEmojiSpam,
  duplicate: detectDuplicate,
  copypasta: detectCopypasta,
  sticker_gif_spam: detectStickerGifSpam,
  attachment_spam: detectAttachmentSpam,
  newline_spam: detectNewlineSpam,
  wall_of_text: detectWallOfText,
  repeated_chars: detectRepeatedChars,
  mass_mentions: detectMassMentions,
  everyone_here: detectEveryoneHere,
  invites: detectInvites,
  links: detectLinks,
  excessive_caps: detectExcessiveCaps,
  zalgo: detectZalgo,
  raid: detectRaid,
};

export async function runMessageDetectors(
  ctx: AutomodMessageContext,
): Promise<AutomodHit | null> {
  for (const ruleId of MESSAGE_RULE_ORDER) {
    const rule = ctx.config.rules[ruleId];
    if (!rule?.enabled) continue;
    const hit = await DETECTORS[ruleId](ctx, rule);
    if (hit) return hit;
  }
  return null;
}

export async function runJoinDetectors(
  ctx: Extract<import("./types.js").AutomodContext, { kind: "join" }>,
): Promise<AutomodHit | null> {
  const rule = ctx.config.rules.raid;
  if (!rule?.enabled) return null;
  return DETECTORS.raid(ctx, rule);
}

export function buildMessageContext(
  message: import("discord.js").Message,
  config: import("../../../../config/schemas/automod.js").AutomodConfig,
): AutomodMessageContext {
  const content = message.content ?? "";
  return {
    kind: "message",
    message,
    member: message.member,
    config,
    content,
    normalized: normalizeForMatch(content),
  };
}

export { MESSAGE_RULE_ORDER, DETECTORS };
