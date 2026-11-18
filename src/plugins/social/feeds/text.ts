/**
 * Text helpers for feed items: HTML to a short plain-text excerpt, Discord markdown/mention
 * escaping, link normalisation and dedupe keys. Pure, no I/O.
 */
import { createHash } from "node:crypto";

export const SUMMARY_MAX_CHARS = 300;
export const TITLE_MAX_CHARS = 250;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  agrave: "à",
  ouml: "ö",
  uuml: "ü",
  auml: "ä",
  szlig: "ß",
  ntilde: "ñ",
  ccedil: "ç",
  times: "×",
  deg: "°",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** HTML (or plain text) to plain text: drops scripts/styles/comments, keeps paragraph breaks as spaces. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|iframe|svg|figure|figcaption)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b\u2028\u2029]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word boundary, adding an ellipsis when anything was dropped. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const space = slice.lastIndexOf(" ");
  return `${(space > max * 0.6 ? slice.slice(0, space) : slice).replace(/[\s,.;:!?-]+$/, "")}…`;
}

/**
 * Escape Discord markdown and neutralise mentions, so feed text can never format or ping. Pings
 * are also blocked by `allowedMentions`; this keeps them from even looking like one.
 */
export function escapeDiscord(text: string): string {
  return text
    .replace(/[\\*_~`|[\]()<>]/g, "\\$&")
    .replace(/^([#>-]|\d+\.)/gm, "\\$1")
    .replace(/@(everyone|here)/gi, "@\u200b$1")
    .replace(/https?:\/\/\S+/gi, (url) => url.replace(/\\([_*~()[\]])/g, "$1"));
}

/** Plain-text, escaped, ~300 char excerpt from HTML or text. Never the full article. */
export function summarize(html: string | null | undefined, max = SUMMARY_MAX_CHARS): string {
  if (!html) return "";
  return escapeDiscord(truncateText(htmlToText(html), max));
}

/** Plain-text, escaped title. */
export function cleanTitle(raw: string | null | undefined, fallback = "Untitled"): string {
  const text = raw ? htmlToText(raw) : "";
  return escapeDiscord(truncateText(text || fallback, TITLE_MAX_CHARS));
}

/** Resolve a (possibly relative) link against a base; null unless the result is http(s). */
export function resolveUrl(raw: string | null | undefined, base?: string | null): string | null {
  if (!raw) return null;
  const value = decodeEntities(String(raw).trim());
  if (!value) return null;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref_src|cmpid|ocid|icid)$/i;

/** A link with tracking parameters, the fragment and a trailing slash removed, for dedupe. */
export function normalizeLink(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function hashKey(...parts: (string | null | undefined)[]): string {
  return `h:${createHash("sha1").update(parts.map((p) => p ?? "").join("\u0001")).digest("hex").slice(0, 32)}`;
}

/** Item dedupe key: guid, then id, then the normalised link, then a hash of title and date. */
export function dedupeKey(input: { guid?: string | null; id?: string | null; link?: string | null; title?: string | null; date?: string | null }): string {
  const guid = input.guid?.trim();
  if (guid) return guid.slice(0, 500);
  const id = input.id?.trim();
  if (id) return id.slice(0, 500);
  if (input.link) return normalizeLink(input.link).slice(0, 500);
  return hashKey(input.title, input.date);
}

/** The first `<img src>` in a chunk of HTML, resolved against `base`. */
export function firstImageInHtml(html: string | null | undefined, base?: string | null): string | null {
  if (!html) return null;
  const re = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const url = resolveUrl(match[1], base);
    // Tracking pixels and spacer gifs aren't article images.
    if (url && !/(?:feedburner|pixel|spacer|1x1|beacon|\/emoji\/|gravatar\.com)/i.test(url)) return url;
  }
  return null;
}

/** A Date, or null for anything unparseable / absurd (before 1995 or more than a day ahead). */
export function parseDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const date = typeof raw === "number" ? new Date(raw < 1e12 ? raw * 1000 : raw) : new Date(String(raw).trim());
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < Date.UTC(1995, 0, 1) || ms > Date.now() + 24 * 3600_000) return null;
  return date;
}
