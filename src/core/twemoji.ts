import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Image } from "@napi-rs/canvas";
import { capMap } from "./mapPrune.js";

/**
 * Twemoji artwork for canvas cards, drawn from the bundled @twemoji/svg package (MIT) instead of a
 * system emoji font. Production hosts often have no colour emoji font at all (so emoji vanished from
 * /rank and /profile), and the website draws every emoji as Twemoji, so this keeps the cards
 * identical to the site everywhere.
 */

const require = createRequire(import.meta.url);

let svgDir: string | null | undefined;

function twemojiDir(): string | null {
  if (svgDir !== undefined) return svgDir;
  try {
    svgDir = dirname(require.resolve("@twemoji/svg/package.json"));
  } catch {
    svgDir = null;
  }
  return svgDir;
}

/**
 * Twemoji's file name for an emoji: lowercase hex code points joined with "-". The U+FE0F variation
 * selector is dropped unless the emoji is a zero-width-joiner sequence (Twemoji's own naming rule).
 */
export function twemojiCode(emoji: string): string {
  const points = Array.from(emoji).map((char) => char.codePointAt(0)!);
  const isZwj = points.includes(0x200d);
  return points
    .filter((point) => isZwj || point !== 0xfe0f)
    .map((point) => point.toString(16))
    .join("-");
}

function svgPath(emoji: string): string | null {
  const dir = twemojiDir();
  if (!dir) return null;
  const exact = join(dir, `${twemojiCode(emoji)}.svg`);
  if (existsSync(exact)) return exact;
  // Some sequences are only shipped without their FE0F (or with it); try the other form.
  const bare = Array.from(emoji)
    .filter((char) => char.codePointAt(0) !== 0xfe0f)
    .map((char) => char.codePointAt(0)!.toString(16))
    .join("-");
  const fallback = join(dir, `${bare}.svg`);
  return existsSync(fallback) ? fallback : null;
}

/** True when this emoji has Twemoji artwork (so a card can draw it without any emoji font). */
export function hasTwemoji(emoji: string | null | undefined): boolean {
  return Boolean(emoji && svgPath(emoji.trim()));
}

const svgCache = new Map<string, string>();
const imageCache = new Map<string, Image>();

/**
 * The emoji as an image rasterised at exactly `sizePx` (the SVG is resized before decoding, so
 * it's crisp at any card scale rather than a small bitmap scaled up). Null when there's no artwork.
 */
export function twemojiImage(emoji: string, sizePx: number): Image | null {
  const trimmed = emoji.trim();
  const path = svgPath(trimmed);
  if (!path) return null;
  const size = Math.max(8, Math.round(sizePx));
  const key = `${path}@${size}`;
  const hit = imageCache.get(key);
  if (hit) return hit;
  let svg = svgCache.get(path);
  if (svg === undefined) {
    try {
      svg = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    svgCache.set(path, svg);
    capMap(svgCache, 256);
  }
  const sized = svg.replace(/<svg\b([^>]*)>/, (_match, attrs: string) => {
    const cleaned = attrs.replace(/\s(width|height)="[^"]*"/g, "");
    return `<svg${cleaned} width="${size}" height="${size}">`;
  });
  try {
    const image = new Image();
    image.src = Buffer.from(sized);
    if (!image.width || !image.height) return null;
    imageCache.set(key, image);
    capMap(imageCache, 512);
    return image;
  } catch {
    return null;
  }
}
