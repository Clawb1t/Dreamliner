/**
 * RSS 2.0 / Atom / RDF (RSS 1.0) parsing on fast-xml-parser. Charset-aware (BOM, XML declaration,
 * Content-Type header; minecraft.net serves UTF-16), relative links resolved against the feed URL,
 * images taken from media:content / media:thumbnail, then an image enclosure, then custom
 * <image>-style tags, then the first <img> in the content. Only a headline, link, short excerpt
 * and image survive; full article text is never kept.
 */
import { XMLParser } from "fast-xml-parser";
import type { FeedItemInput } from "./types.js";
import { cleanTitle, dedupeKey, firstImageInHtml, htmlToText, parseDate, resolveUrl, summarize } from "./text.js";

export class FeedParseError extends Error {}

export type ParsedFeed = {
  format: "rss" | "atom" | "rdf";
  title: string;
  siteUrl: string | null;
  iconUrl: string | null;
  items: FeedItemInput[];
};

/** Items kept per parse: feeds with hundreds of entries only need the newest few. */
export const MAX_PARSED_ITEMS = 50;

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

function normalizeCharset(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!value) return null;
  if (value === "utf8") return "utf-8";
  if (value === "utf-16" || value === "utf16") return "utf-16le";
  if (value === "latin1" || value === "latin-1") return "iso-8859-1";
  return value;
}

function tryDecoder(charset: string): InstanceType<typeof TextDecoder> | null {
  try {
    return new TextDecoder(charset, { fatal: false });
  } catch {
    return null;
  }
}

/** Bytes to text, honouring a BOM first, then the XML declaration, then the Content-Type charset. */
export function decodeFeedBody(body: Buffer, contentType?: string | null): string {
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return new TextDecoder("utf-16le").decode(body.subarray(2));
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return new TextDecoder("utf-16be").decode(body.subarray(2));
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return new TextDecoder("utf-8").decode(body.subarray(3));
  // UTF-16 without a BOM: "<?" encoded as 3C 00 3F 00 (LE) or 00 3C 00 3F (BE).
  if (body.length >= 4 && body[0] === 0x3c && body[1] === 0x00 && body[2] === 0x3f && body[3] === 0x00) {
    return new TextDecoder("utf-16le").decode(body);
  }
  if (body.length >= 4 && body[0] === 0x00 && body[1] === 0x3c && body[2] === 0x00 && body[3] === 0x3f) {
    return new TextDecoder("utf-16be").decode(body);
  }
  const head = body.subarray(0, 200).toString("latin1");
  const declared = normalizeCharset(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]);
  const header = normalizeCharset(/charset\s*=\s*([^;\s]+)/i.exec(contentType ?? "")?.[1]);
  for (const charset of [declared, header, "utf-8"]) {
    if (!charset) continue;
    // A UTF-16 declaration on a body that clearly isn't UTF-16 (checked above) is wrong: skip it.
    if (charset.startsWith("utf-16")) continue;
    const decoder = tryDecoder(charset);
    if (decoder) return decoder.decode(body);
  }
  return body.toString("utf8");
}

// ---------------------------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

const ARRAY_TAGS = new Set([
  "item",
  "entry",
  "link",
  "category",
  "media:content",
  "media:thumbnail",
  "media:group",
  "enclosure",
  "atom:link",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  cdataPropName: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

/** Text of a node that may be a string, a number, or `{ "#text": ... }`. */
function text(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === "object") {
    const value = (node as XmlNode)["#text"];
    if (value !== undefined) return text(value);
  }
  return "";
}

function attr(node: unknown, name: string): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  const value = (node as XmlNode)[`@_${name}`];
  return typeof value === "string" ? value : value === undefined ? "" : String(value);
}

function asArray(node: unknown): unknown[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

function child(node: unknown, ...names: string[]): unknown {
  if (!node || typeof node !== "object") return undefined;
  for (const name of names) {
    const value = (node as XmlNode)[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;

function isImageMedia(node: unknown): boolean {
  const medium = attr(node, "medium").toLowerCase();
  const type = attr(node, "type").toLowerCase();
  if (medium) return medium === "image";
  if (type) return type.startsWith("image/");
  return IMAGE_EXT.test(attr(node, "url"));
}

/** media:content / media:thumbnail (also inside media:group), largest width first. */
function mediaImage(item: unknown, base: string): string | null {
  const groups = [item, ...asArray(child(item, "media:group"))];
  const contents: unknown[] = [];
  const thumbs: unknown[] = [];
  for (const group of groups) {
    contents.push(...asArray(child(group, "media:content")).filter(isImageMedia));
    thumbs.push(...asArray(child(group, "media:thumbnail")));
  }
  const byWidth = (a: unknown, b: unknown) => Number(attr(b, "width") || 0) - Number(attr(a, "width") || 0);
  for (const node of [...contents.sort(byWidth), ...thumbs.sort(byWidth)]) {
    const url = resolveUrl(attr(node, "url"), base);
    if (url) return url;
  }
  return null;
}

function enclosureImage(item: unknown, base: string): string | null {
  for (const node of asArray(child(item, "enclosure"))) {
    const type = attr(node, "type").toLowerCase();
    const url = attr(node, "url") || attr(node, "href");
    if (type.startsWith("image/") || (!type && IMAGE_EXT.test(url))) {
      const resolved = resolveUrl(url, base);
      if (resolved) return resolved;
    }
  }
  // Atom: <link rel="enclosure" type="image/...">
  for (const node of asArray(child(item, "link"))) {
    if (attr(node, "rel") === "enclosure" && attr(node, "type").toLowerCase().startsWith("image/")) {
      const resolved = resolveUrl(attr(node, "href"), base);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Non-standard image tags some publishers use (Bungie's <image>, <thumbnail>, <og:image>...). */
function customImage(item: unknown, base: string): string | null {
  for (const name of ["image", "thumbnail", "thumb", "og:image", "itunes:image", "featuredImage", "featured_image"]) {
    const node = child(item, name);
    if (node === undefined) continue;
    const candidate = text(child(node, "url")) || attr(node, "href") || attr(node, "url") || text(node);
    const url = resolveUrl(candidate, base);
    if (url) return url;
  }
  return null;
}

function categories(item: unknown): string[] {
  const out: string[] = [];
  for (const node of asArray(child(item, "category"))) {
    const value = (attr(node, "term") || attr(node, "label") || text(node)).trim();
    if (value) out.push(htmlToText(value).slice(0, 60));
  }
  for (const node of asArray(child(item, "media:keywords"))) {
    for (const value of text(node).split(",")) if (value.trim()) out.push(value.trim().slice(0, 60));
  }
  return [...new Set(out)].slice(0, 15);
}

function atomLink(node: unknown, base: string, rels = ["alternate", ""]): string | null {
  const links = asArray(child(node, "link"));
  for (const rel of rels) {
    for (const link of links) {
      const linkRel = attr(link, "rel");
      if ((linkRel || "") === rel || (rel === "alternate" && !linkRel)) {
        const href = attr(link, "href") || text(link);
        const url = resolveUrl(href, base);
        if (url) return url;
      }
    }
  }
  return null;
}

function rssLink(item: unknown, base: string): string | null {
  for (const link of asArray(child(item, "link"))) {
    // Some RSS feeds mix in atom:link-style nodes under <link>.
    const value = text(link) || attr(link, "href");
    const url = resolveUrl(value, base);
    if (url) return url;
  }
  const guid = child(item, "guid");
  if (guid !== undefined && attr(guid, "isPermaLink") !== "false") {
    // Only an absolute guid counts as a link (a bare id would resolve to a bogus relative URL).
    const url = resolveUrl(text(guid));
    if (url) return url;
  }
  return null;
}

function authorOf(item: unknown): string | null {
  const node = child(item, "dc:creator", "author", "itunes:author");
  if (node === undefined) return null;
  const name = text(child(node, "name")) || text(node);
  const cleaned = htmlToText(name).replace(/^[^\s@]+@[^\s@]+\s*\((.+)\)$/, "$1").trim();
  return cleaned ? cleaned.slice(0, 100) : null;
}

function toItem(entry: unknown, base: string, kind: "rss" | "atom"): FeedItemInput | null {
  const titleRaw = text(child(entry, "title"));
  const link = kind === "atom" ? atomLink(entry, base) : rssLink(entry, base);
  const contentHtml = text(child(entry, "content:encoded", "content"));
  const descriptionHtml = text(child(entry, "description", "summary", "media:description"));
  const dateRaw = text(child(entry, "pubDate", "published", "updated", "dc:date", "issued", "modified"));
  const guid = kind === "rss" ? text(child(entry, "guid")) : "";
  const id = kind === "atom" ? text(child(entry, "id")) : "";
  if (!titleRaw && !link && !descriptionHtml) return null;

  const imageBase = link ?? base;
  const imageUrl =
    mediaImage(entry, imageBase) ??
    enclosureImage(entry, imageBase) ??
    customImage(entry, imageBase) ??
    firstImageInHtml(contentHtml, imageBase) ??
    firstImageInHtml(descriptionHtml, imageBase);

  return {
    key: dedupeKey({ guid, id, link, title: titleRaw, date: dateRaw }),
    title: cleanTitle(titleRaw || htmlToText(descriptionHtml).slice(0, 80) || link || ""),
    url: link ?? "",
    imageUrl,
    summary: summarize(descriptionHtml || contentHtml),
    author: authorOf(entry),
    tags: categories(entry),
    publishedAt: parseDate(dateRaw),
  };
}

/** Remove a DOCTYPE (and any internal entity subset) before parsing: no entity expansion tricks. */
function stripDoctype(xml: string): string {
  return xml.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "");
}

/** Parse an RSS/Atom/RDF document. `feedUrl` is the base for relative links. Throws FeedParseError. */
export function parseFeed(body: Buffer | string, feedUrl: string, contentType?: string | null): ParsedFeed {
  const xml = stripDoctype(typeof body === "string" ? body : decodeFeedBody(body, contentType)).replace(/^﻿/, "");
  if (!/<(rss|feed|rdf:RDF|channel)\b/i.test(xml.slice(0, 4000))) {
    throw new FeedParseError(/<html\b/i.test(xml.slice(0, 2000)) ? "That's a web page, not a feed. Look for its RSS or Atom link." : "That isn't an RSS or Atom feed.");
  }
  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (error) {
    throw new FeedParseError(`The feed couldn't be read (${(error as Error).message.slice(0, 80)}).`);
  }

  const rss = child(doc, "rss") as XmlNode | undefined;
  const atom = child(doc, "feed") as XmlNode | undefined;
  const rdf = child(doc, "rdf:RDF") as XmlNode | undefined;

  if (atom) {
    const siteUrl = atomLink(atom, feedUrl) ?? null;
    const base = resolveUrl(attr(atom, "xml:base"), feedUrl) ?? feedUrl;
    const items = asArray(child(atom, "entry"))
      .slice(0, MAX_PARSED_ITEMS)
      .map((entry) => toItem(entry, base, "atom"))
      .filter((item): item is FeedItemInput => item !== null);
    return {
      format: "atom",
      title: htmlToText(text(child(atom, "title"))).slice(0, 200),
      siteUrl,
      iconUrl: resolveUrl(text(child(atom, "icon", "logo")), feedUrl),
      items,
    };
  }

  const channel = (rss ? child(rss, "channel") : rdf ? child(rdf, "channel") : child(doc, "channel")) as XmlNode | undefined;
  const container = rdf ?? channel;
  if (!container) throw new FeedParseError("That isn't an RSS or Atom feed.");
  const entries = asArray(child(channel, "item")).length ? asArray(child(channel, "item")) : asArray(child(container, "item"));
  const items = entries
    .slice(0, MAX_PARSED_ITEMS)
    .map((entry) => toItem(entry, feedUrl, "rss"))
    .filter((item): item is FeedItemInput => item !== null);
  const image = child(channel, "image");
  return {
    format: rdf ? "rdf" : "rss",
    title: htmlToText(text(child(channel, "title"))).slice(0, 200),
    siteUrl: rssLink(channel, feedUrl),
    iconUrl: resolveUrl(text(child(image, "url")) || text(child(channel, "atom:icon", "icon")), feedUrl),
    items,
  };
}
