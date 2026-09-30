import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts } from "@napi-rs/canvas";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

let ready = false;
let hasInter = false;

function tryRegister(path: string, face: string): boolean {
  if (!existsSync(path)) return false;
  try {
    GlobalFonts.registerFromPath(path, face);
    return true;
  } catch {
    return false;
  }
}

function ensureFonts(): void {
  if (ready) return;
  ready = true;

  const dir = join(ROOT, "assets", "fonts");
  const bold = tryRegister(join(dir, "Inter-Bold.ttf"), "Inter Bold");
  const semi = tryRegister(join(dir, "Inter-SemiBold.ttf"), "Inter SemiBold");
  const regular = tryRegister(join(dir, "Inter-Regular.ttf"), "Inter");
  hasInter = bold || semi || regular;

  if (hasInter) return;

  // Last-resort system faces so cards never fall back to a tiny bitmap sans.
  for (const [path, face] of [
    ["C:/Windows/Fonts/segoeuib.ttf", "Segoe UI"],
    ["C:/Windows/Fonts/segoeui.ttf", "Segoe UI"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVu Sans"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans"],
  ] as const) {
    tryRegister(path, face);
  }
}

/** CSS font shorthand using bundled Inter when available. */
export function cardFont(weight: 400 | 500 | 600 | 700, sizePx: number): string {
  ensureFonts();
  if (hasInter) {
    if (weight >= 700) return `${sizePx}px "Inter Bold", "Segoe UI", Arial, sans-serif`;
    if (weight >= 500) return `${sizePx}px "Inter SemiBold", "Inter", "Segoe UI", Arial, sans-serif`;
    return `${sizePx}px "Inter", "Segoe UI", Arial, sans-serif`;
  }
  return `${weight} ${sizePx}px "Segoe UI", "DejaVu Sans", Arial, sans-serif`;
}

// Plus Jakarta Sans, the website's own typeface, as static weights cut from the site's variable
// font (the CSS weights the site uses). Registered under private names so a system copy of the
// family can't shadow them. For cards that mirror a site component exactly (/profile).
const SITE_WEIGHTS = [500, 650, 750] as const;
let siteFontsReady = false;
let hasSiteFont = false;

function ensureSiteFonts(): void {
  if (siteFontsReady) return;
  siteFontsReady = true;
  ensureFonts();
  const dir = join(ROOT, "assets", "fonts");
  for (const weight of SITE_WEIGHTS) {
    if (tryRegister(join(dir, `PlusJakartaSans-${weight}.ttf`), `DL Jakarta ${weight}`)) hasSiteFont = true;
  }
}

/** CSS font shorthand in the site's typeface, falling back to the card fonts (and an emoji face
 *  when one is registered) for anything it doesn't cover. */
export function siteFont(weight: (typeof SITE_WEIGHTS)[number], sizePx: number): string {
  ensureSiteFonts();
  const fallback = cardFont(weight >= 650 ? 700 : 500, sizePx).replace(`${sizePx}px `, "");
  const emoji = `"Rank Card Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
  return hasSiteFont
    ? `${sizePx}px "DL Jakarta ${weight}", ${fallback.replace(/, sans-serif$/, "")}, ${emoji}, sans-serif`
    : `${sizePx}px ${fallback.replace(/, sans-serif$/, "")}, ${emoji}, sans-serif`;
}
