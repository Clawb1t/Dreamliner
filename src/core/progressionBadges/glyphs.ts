import { createCanvas, Path2D } from "@napi-rs/canvas";

/**
 * Generated tier art for progression badges made without uploaded images: the stat's glyph in
 * white on a soft rounded tile in the tier's colour, with small pips for the tier number. Flat, no
 * outline. A superuser can replace any tier's art later by uploading an image.
 */

/** Stroke paths on a 24×24 grid, drawn 2px wide with round caps. */
const GLYPHS = {
  message: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M6 11a6 6 0 0 0 12 0 M12 17v4",
  calendar: "M5 6h14v14H5z M5 10h14 M9 3v4 M15 3v4",
  flame: "M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4.5 3-6.5 1 2 2 2.5 3 2.5 0-3-1-5 0-7z",
  grid: "M5 5h6v6H5z M13 5h6v6h-6z M5 13h6v6H5z M13 13h6v6h-6z",
  command: "M5 5h14v14H5z M14 8l-4 8",
  smile: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M8 14c1.5 2 6.5 2 8 0 M9 9.5v.5 M15 9.5v.5",
  music: "M9 17V6l10-2v11 M9 17a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z M19 15a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z",
  heart: "M12 20s-8-5-8-11a4 4 0 0 1 8-1a4 4 0 0 1 8 1c0 6-8 11-8 11z",
  coin: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M15 9c-.5-1-1.5-1.5-3-1.5-2 0-3 1-3 2s1 1.6 3 2 3 1 3 2-1 2-3 2c-1.5 0-2.5-.5-3-1.5 M12 6v1.5 M12 16.5V18",
  bulb: "M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c1 1 1 2 1 3h6c0-1 0-2 1-3A6 6 0 0 0 12 3z",
  pen: "M5 19h4L19 9l-4-4L5 15z M13 7l4 4",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z",
  user_plus: "M10 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8z M3 21a7 7 0 0 1 14 0 M19 8v6 M16 11h6",
  gift: "M4 10h16v10H4z M3 7h18v3H3z M12 7v13 M12 7c-1.5-3.5-5.5-3-4.5-.5 M12 7c1.5-3.5 5.5-3 4.5-.5",
  cake: "M4 12h16v8H4z M4 15.5c2 1.5 4 1.5 6 0s4-1.5 6 0 3 1.5 4 0 M12 12V8 M12 4.5v.5",
  clipboard: "M9 3h6v3H9z M7 4.5H5V21h14V4.5h-2 M8.5 11h7 M8.5 15h4.5",
  wand: "M4 20L15 9 M15 4v3 M20 9h-3 M18.5 5.5l-2 2",
  film: "M4 5h16v14H4z M4 9h16 M4 15h16 M9 5v4 M15 5v4 M9 15v4 M15 15v4",
  check: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M8 12.5l2.5 2.5L16 9.5",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0z M12 13v4 M8.5 20h7 M8 6H5a3 3 0 0 0 3 4 M16 6h3a3 3 0 0 1-3 4",
  card: "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M9.5 8h5 M9.5 12h5 M9.5 16h3",
  box: "M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8",
  swap: "M5 8h13 M15 5l3 3-3 3 M19 16H6 M9 13l-3 3 3 3",
  plane: "M21 4L3 11l6 2.5L11.5 20l3-5.5L21 4z M9 13.5l12-9.5",
  layers: "M12 4l9 4.5-9 4.5-9-4.5z M3 13l9 4.5 9-4.5",
  gem: "M7 4h10l4 5-9 11L3 9z M3 9h18 M9.5 4L12 9l2.5-5",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3.5 2",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  sparkle: "M12 3v5 M12 16v5 M3 12h5 M16 12h5 M6 6l2.5 2.5 M15.5 15.5L18 18 M6 18l2.5-2.5 M15.5 8.5L18 6",
} as const;

export type GlyphId = keyof typeof GLYPHS;

export const GLYPH_IDS = Object.keys(GLYPHS) as GlyphId[];

/** Tier colours, lowest first: bronze, silver, gold, then jewel tones for longer ladders. */
export const TIER_COLOURS = [
  "#B9784A",
  "#8F9BA8",
  "#D2A12E",
  "#2E9E77",
  "#2F7ED0",
  "#7457D1",
  "#C9476A",
  "#E07B39",
  "#2AA7B5",
  "#3B3F4C",
] as const;

function mix(hex: string, toward: number, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = (value >> shift) & 0xff;
    return Math.round(c + (toward - c) * amount);
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/** A 256×256 PNG for tier `tier` (1-based) of `total`, using `glyph` (falls back to sparkle). */
export function generateTierArt(glyph: string, tier: number, total: number): Buffer {
  const size = 256;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const colour = TIER_COLOURS[Math.max(0, Math.min(TIER_COLOURS.length - 1, tier - 1))]!;

  // Soft tile: a gentle top-to-bottom gradient of the tier colour, no outline.
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, mix(colour, 255, 0.22));
  gradient.addColorStop(1, mix(colour, 0, 0.12));
  ctx.fillStyle = gradient;
  const r = 64;
  ctx.beginPath();
  ctx.roundRect(8, 8, size - 16, size - 16, r);
  ctx.fill();

  // The stat glyph, scaled from its 24-unit grid.
  const path = new Path2D(GLYPHS[(glyph in GLYPHS ? glyph : "sparkle") as GlyphId]);
  const scale = 6;
  ctx.save();
  ctx.translate((size - 24 * scale) / 2, (size - 24 * scale) / 2 - (total > 1 ? 10 : 0));
  ctx.scale(scale, scale);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(path);
  ctx.restore();

  // Tier pips along the bottom: filled up to this tier.
  if (total > 1) {
    const pips = Math.min(total, 10);
    const gap = 16;
    const startX = size / 2 - ((pips - 1) * gap) / 2;
    for (let index = 0; index < pips; index++) {
      ctx.beginPath();
      ctx.arc(startX + index * gap, size - 40, 5, 0, Math.PI * 2);
      ctx.fillStyle = index < tier ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.35)";
      ctx.fill();
    }
  }
  return canvas.toBuffer("image/png");
}
