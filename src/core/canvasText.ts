/**
 * Text for @napi-rs/canvas images (/rank, /profile): drops characters no font on this machine can
 * draw, so a fancy display name never shows the .notdef "No Glyph" box.
 *
 * Detection is measured, not guessed: each unique codepoint is drawn once with the card's own font
 * stack (so the bundled fonts, the emoji font and Skia's system fallback all count) and compared
 * pixel for pixel with a codepoint no font maps. Results are cached per font stack, so a name only
 * costs a few tiny renders the first time a new character shows up.
 */
import { createCanvas } from "@napi-rs/canvas";

export type GlyphSupport = (codePoint: number) => boolean;

/** Kept inside a cluster whose base character is drawable: they join, modify or select a
 *  presentation and have no glyph of their own (ZWJ/ZWNJ, variation selectors, keycap, skin tones,
 *  emoji tag characters). */
const CLUSTER_GLUE = /^[‌‍︀-️⃣\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}\u{E0100}-\u{E01EF}]$/u;
const WHITESPACE = /^\s$/u;
/** Invisible controls and format characters (bidi overrides, zero-width spaces, ...) that aren't
 *  glue, and lone surrogates. Unassigned and private-use codepoints are left to the measurement:
 *  a font may know a newer emoji than this Node build's Unicode tables. */
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Cs}]$/u;
const MARK = /^\p{M}$/u;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Removes every character `isSupported` rejects, keeping grapheme clusters (ZWJ emoji, skin
 * tones, flags, keycaps, accented letters) whole when their base character is drawable. Whitespace
 * becomes a single space and the result is trimmed.
 */
export function stripUnsupportedGlyphs(text: string, isSupported: GlyphSupport): string {
  let out = "";
  for (const { segment } of segmenter.segment(text)) {
    const codePoints = [...segment];
    const base = codePoints[0]!;
    if (WHITESPACE.test(base)) {
      out += " ";
      continue;
    }
    if (INVISIBLE.test(base) || CLUSTER_GLUE.test(base) || !isSupported(base.codePointAt(0)!)) continue;
    let cluster = base;
    for (const char of codePoints.slice(1)) {
      if (CLUSTER_GLUE.test(char)) cluster += char;
      else if (INVISIBLE.test(char)) continue;
      else if (isSupported(char.codePointAt(0)!)) cluster += char;
    }
    // A joiner left dangling by a dropped emoji part would join onto the next character.
    out += cluster.replace(/[‌‍]+$/u, "");
  }
  return out.replace(/\s{2,}/gu, " ").trim();
}

/** The first of `candidates` that still has something to show once cleaned, else `fallback`. */
export function cleanCanvasName(
  candidates: Array<string | null | undefined>,
  isSupported: GlyphSupport,
  fallback = "Unknown user",
): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const cleaned = stripUnsupportedGlyphs(candidate, isSupported);
    if (/[\p{L}\p{N}\p{S}\p{P}]/u.test(cleaned)) return cleaned;
  }
  return fallback;
}

/** The first whole user-perceived character of `text` (an emoji or accented letter may span
 *  several code units), or undefined for an empty string. */
export function firstGrapheme(text: string): string | undefined {
  for (const { segment } of segmenter.segment(text)) return segment;
  return undefined;
}

/**
 * Shortens `text` with an ellipsis until `fits` accepts it, cutting whole graphemes only: cutting
 * by code unit can split an emoji into a lone surrogate, which draws as a .notdef box.
 */
export function truncateToFit(text: string, fits: (candidate: string) => boolean, ellipsis = "…"): string {
  if (fits(text)) return text;
  const parts = Array.from(segmenter.segment(text), (s) => s.segment);
  while (parts.length > 1) {
    parts.pop();
    const candidate = `${parts.join("").trimEnd()}${ellipsis}`;
    if (fits(candidate)) return candidate;
  }
  return `${parts.join("")}${ellipsis}`;
}

// --- Measured support, per font stack ------------------------------------------------------------

/** Unassigned in Unicode, so no font maps it: whatever it draws is the .notdef glyph. */
const NOTDEF_PROBE = "͸";
const PROBE_W = 128;
const PROBE_H = 72;
const PROBE_SIZE = 32;
const MAX_CACHED_PER_FONT = 4096;

type FontProbe = {
  draw: (text: string) => Uint8ClampedArray;
  notdef: Uint8ClampedArray | null;
  markNotdef: Uint8ClampedArray | null;
  results: Map<number, boolean>;
};

const probes = new Map<string, FontProbe>();

function sameImage(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isBlank(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

function probeFor(font: string): FontProbe {
  // Support doesn't depend on size: one fixed probe size per font stack.
  const key = font.replace(/\d+(?:\.\d+)?px/u, `${PROBE_SIZE}px`);
  const cached = probes.get(key);
  if (cached) return cached;

  const canvas = createCanvas(PROBE_W, PROBE_H);
  const ctx = canvas.getContext("2d");
  const draw = (text: string) => {
    ctx.clearRect(0, 0, PROBE_W, PROBE_H);
    ctx.font = key;
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(text, 24, 48);
    return ctx.getImageData(0, 0, PROBE_W, PROBE_H).data;
  };
  const notdef = draw(NOTDEF_PROBE);
  const probe: FontProbe = {
    draw,
    // A blank .notdef never shows a box, so there's nothing to strip for this font stack.
    notdef: isBlank(notdef) ? null : notdef,
    markNotdef: isBlank(notdef) ? null : draw(`x${NOTDEF_PROBE}`),
    results: new Map(),
  };
  probes.set(key, probe);
  return probe;
}

/** Whether `font` (a canvas font shorthand) can draw `codePoint` without falling back to .notdef. */
export function canvasGlyphSupport(font: string): GlyphSupport {
  return (codePoint) => {
    if (codePoint >= 0x20 && codePoint <= 0x7e) return true; // every card font covers ASCII
    const probe = probeFor(font);
    if (!probe.notdef || !probe.markNotdef) return true;
    const known = probe.results.get(codePoint);
    if (known !== undefined) return known;

    const char = String.fromCodePoint(codePoint);
    // Combining marks are drawn on a base letter: alone, the shaper adds a dotted circle.
    const supported = MARK.test(char)
      ? !sameImage(probe.draw(`x${char}`), probe.markNotdef)
      : !sameImage(probe.draw(char), probe.notdef);
    if (probe.results.size >= MAX_CACHED_PER_FONT) probe.results.clear();
    probe.results.set(codePoint, supported);
    return supported;
  };
}

/** True when this font stack draws a visible .notdef box (so unsupported characters matter). */
export function canvasShowsNotdef(font: string): boolean {
  return probeFor(font).notdef !== null;
}

/** `text` without the characters `font` can't draw (see stripUnsupportedGlyphs). */
export function sanitizeCanvasText(text: string, font: string): string {
  return stripUnsupportedGlyphs(text, canvasGlyphSupport(font));
}
