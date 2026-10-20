import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts } from "@napi-rs/canvas";

/**
 * Name fonts sold in the store. The same Google Fonts families (all SIL Open Font License, see the
 * *-OFL.txt files next to them in assets/fonts/cosmetic) are used by the website, keyed by these
 * shared ids. Registered under private names so a system copy of a family can't shadow them.
 * MuseoModerno (weight 700) and Grenze Gotisch (weight 600) are static instances cut from the
 * Google Fonts variable files with fontTools, since canvas draws a variable font's default
 * instance (MuseoModerno's is Thin); the website should use the same weights.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIR = join(ROOT, "assets", "fonts", "cosmetic");

export type NameFontDef = {
  id: string;
  /** The Google Fonts family (the website loads the same one). */
  family: string;
  file: string;
  /** Size multiplier so every face reads at about the same height as the default name font. */
  scale: number;
};

export const NAME_FONTS = [
  { id: "pixel", family: "Pixelify Sans", file: "PixelifySans.ttf", scale: 1.0 },
  { id: "sakura", family: "Cherry Bomb One", file: "CherryBombOne-Regular.ttf", scale: 0.98 },
  { id: "jelly", family: "Chicle", file: "Chicle-Regular.ttf", scale: 1.12 },
  { id: "modern", family: "MuseoModerno", file: "MuseoModerno-Bold.ttf", scale: 1.0 },
  { id: "medieval", family: "Grenze Gotisch", file: "GrenzeGotisch-SemiBold.ttf", scale: 1.1 },
  { id: "vampyre", family: "Pirata One", file: "PirataOne-Regular.ttf", scale: 1.1 },
  { id: "slab", family: "Zilla Slab", file: "ZillaSlab-Bold.ttf", scale: 1.06 },
  { id: "script", family: "Pacifico", file: "Pacifico-Regular.ttf", scale: 0.9 },
  { id: "bold-comic", family: "Bangers", file: "Bangers-Regular.ttf", scale: 1.1 },
  { id: "mono", family: "Space Mono", file: "SpaceMono-Bold.ttf", scale: 0.92 },
] as const satisfies readonly NameFontDef[];

export type NameFontId = (typeof NAME_FONTS)[number]["id"];
export const NAME_FONT_IDS = NAME_FONTS.map((font) => font.id) as unknown as readonly [NameFontId, ...NameFontId[]];

export function isNameFontId(value: unknown): value is NameFontId {
  return typeof value === "string" && (NAME_FONT_IDS as readonly string[]).includes(value);
}

export function nameFontDef(id: string | null | undefined): NameFontDef | null {
  return NAME_FONTS.find((font) => font.id === id) ?? null;
}

const registered = new Map<string, boolean>();

function faceName(id: string): string {
  return `DL Name ${id}`;
}

/** The registered family name of a name font (registering it first). */
export function nameFontFace(id: string): string {
  ensureNameFont(id);
  return faceName(id);
}

/** Registers one font (once). False when its file is missing or unreadable. */
export function ensureNameFont(id: string): boolean {
  const known = registered.get(id);
  if (known !== undefined) return known;
  const def = nameFontDef(id);
  let ok = false;
  if (def) {
    const path = join(DIR, def.file);
    if (existsSync(path)) {
      try {
        GlobalFonts.registerFromPath(path, faceName(id));
        ok = true;
      } catch {
        ok = false;
      }
    }
  }
  registered.set(id, ok);
  return ok;
}

/**
 * A canvas font shorthand for a name in the cosmetic font, falling back to `fallbackFont`'s
 * families (glyph by glyph: Skia falls back across the listed families) for anything the cosmetic
 * face doesn't cover, like emoji or CJK. Returns `fallbackFont` unchanged without a usable font.
 */
export function nameFontStack(fontId: string | null | undefined, sizePx: number, fallbackFont: string): { font: string; sizePx: number } {
  const def = nameFontDef(fontId);
  if (!def || !ensureNameFont(def.id)) return { font: fallbackFont, sizePx };
  const size = Math.round(sizePx * def.scale * 100) / 100;
  // Drop the size (and any weight) from the fallback shorthand, keeping its family list.
  const families = fallbackFont.replace(/^.*?\d+(?:\.\d+)?px\s+/u, "");
  return { font: `${size}px "${faceName(def.id)}", ${families}`, sizePx: size };
}
