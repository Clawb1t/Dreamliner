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
