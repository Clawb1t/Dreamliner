import { createCanvas, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { loadImageSafe } from "../safeImage.js";
import { GLOBAL_ASSET_KEY, readPageAsset } from "../pageAssets.js";
import { canvasGlyphSupport, canvasShowsNotdef, type GlyphSupport } from "../canvasText.js";
import { nameFontDef, nameFontStack, nameFontFace } from "./fonts.js";
import type {
  BarStyle,
  FlairStyle,
  FrameStyle,
  GlowStyle,
  IconStyle,
  NameColorStyle,
  NameFontStyle,
  TitleStyle,
} from "./types.js";

/**
 * Canvas renderers for store cosmetics on the image cards (/rank, /profile, the image
 * leaderboard). Everything is procedural (no art needed), seeded so a card looks the same every
 * time, and drawn in card units: the cards scale their context, and blur/shadow sizes (which
 * canvas applies in device pixels) are scaled to match here.
 */

// --- Small helpers ---------------------------------------------------------------------------------

export type Rect = { x: number; y: number; w: number; h: number };

function deviceScale(ctx: SKRSContext2D): number {
  const m = ctx.getTransform();
  return Math.hypot(m.a, m.b) || 1;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  return [Number.parseInt(n.slice(0, 2), 16) || 0, Number.parseInt(n.slice(2, 4), 16) || 0, Number.parseInt(n.slice(4, 6), 16) || 0];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** `a` mixed toward `b` by `t` (0 = a, 1 = b), as #rrggbb. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

function pick(colors: readonly string[] | undefined, index: number, fallback: string): string {
  if (!colors || colors.length === 0) return fallback;
  return colors[index % colors.length] ?? fallback;
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A small deterministic PRNG (mulberry32). */
export function seededRandom(seed: string | number): () => number {
  let a = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** A point `t` (0..1, clockwise from the top-left of the top edge) along a rounded rectangle's
 *  outline, with the outward normal angle there. */
export function perimeterPoint(x: number, y: number, w: number, h: number, r: number, t: number): { x: number; y: number; angle: number } {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  const sw = w - 2 * rad;
  const sh = h - 2 * rad;
  const arc = (Math.PI / 2) * rad;
  const total = 2 * sw + 2 * sh + 4 * arc;
  let d = (((t % 1) + 1) % 1) * total;
  const segments: Array<[number, (u: number) => { x: number; y: number; angle: number }]> = [
    [sw, (u) => ({ x: x + rad + u, y, angle: -Math.PI / 2 })],
    [arc, (u) => { const a = -Math.PI / 2 + u / (rad || 1); return { x: x + w - rad + Math.cos(a) * rad, y: y + rad + Math.sin(a) * rad, angle: a }; }],
    [sh, (u) => ({ x: x + w, y: y + rad + u, angle: 0 })],
    [arc, (u) => { const a = u / (rad || 1); return { x: x + w - rad + Math.cos(a) * rad, y: y + h - rad + Math.sin(a) * rad, angle: a }; }],
    [sw, (u) => ({ x: x + w - rad - u, y: y + h, angle: Math.PI / 2 })],
    [arc, (u) => { const a = Math.PI / 2 + u / (rad || 1); return { x: x + rad + Math.cos(a) * rad, y: y + h - rad + Math.sin(a) * rad, angle: a }; }],
    [sh, (u) => ({ x, y: y + h - rad - u, angle: Math.PI })],
    [arc, (u) => { const a = Math.PI + u / (rad || 1); return { x: x + rad + Math.cos(a) * rad, y: y + rad + Math.sin(a) * rad, angle: a }; }],
  ];
  for (const [length, at] of segments) {
    if (d <= length || length === total) return at(Math.min(d, length));
    d -= length;
  }
  return segments[0]![1](0);
}

function heartPath(ctx: SKRSContext2D, cx: number, cy: number, size: number): void {
  const s = size / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.9);
  ctx.bezierCurveTo(cx - s * 1.6, cy - s * 0.1, cx - s * 0.7, cy - s * 1.25, cx, cy - s * 0.45);
  ctx.bezierCurveTo(cx + s * 0.7, cy - s * 1.25, cx + s * 1.6, cy - s * 0.1, cx, cy + s * 0.9);
  ctx.closePath();
}

function starPath(ctx: SKRSContext2D, cx: number, cy: number, outer: number, points = 5, innerRatio = 0.45, rotation = -Math.PI / 2): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : outer * innerRatio;
    const a = rotation + (i * Math.PI) / points;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** A four-point twinkle. */
function sparklePath(ctx: SKRSContext2D, cx: number, cy: number, size: number): void {
  starPath(ctx, cx, cy, size, 4, 0.28, 0);
}

// --- Images ------------------------------------------------------------------------------------------

const imageCache = new Map<string, Image>();
const stillCache = new Map<string, Image>();
const STORE_ASSET = /^\/api\/store\/assets\/([a-zA-Z0-9_-]{1,64})$/;

/** Uploaded cosmetic art (a site-relative /api/store/assets/<id> URL), read from local storage. */
export async function loadCosmeticImage(url: string | null | undefined, options: { large?: boolean } = {}): Promise<Image | null> {
  if (!url) return null;
  // Background stills are card-sized (several MB decoded), so they get a much smaller cache.
  const cache = options.large ? stillCache : imageCache;
  const limit = options.large ? 12 : 64;
  const cached = cache.get(url);
  if (cached) {
    cache.delete(url);
    cache.set(url, cached);
    return cached;
  }
  const id = STORE_ASSET.exec(url)?.[1];
  if (!id) return null;
  const buffer = readPageAsset(GLOBAL_ASSET_KEY, "store", id);
  if (!buffer) return null;
  try {
    const image = await loadImageSafe(buffer);
    cache.set(url, image);
    while (cache.size > limit) cache.delete(cache.keys().next().value!);
    return image;
  } catch {
    return null;
  }
}

// --- Names, titles and icons --------------------------------------------------------------------

/** The font shorthand for a name: the cosmetic face first, then `baseFont`'s families. */
export function cosmeticNameFont(nameFont: NameFontStyle | undefined | null, sizePx: number, baseFont: string): string {
  return nameFontStack(nameFont?.fontId, sizePx, baseFont).font;
}

const inkCache = new Map<string, boolean>();

/** Whether `face` alone draws any pixels for `codePoint`. */
function faceDrawsInk(face: string, codePoint: number): boolean {
  const key = `${face}:${codePoint}`;
  const known = inkCache.get(key);
  if (known !== undefined) return known;
  const probe = createCanvas(48, 48);
  const ctx = probe.getContext("2d");
  ctx.font = `28px "${face}"`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(String.fromCodePoint(codePoint), 8, 36);
  const data = ctx.getImageData(0, 0, 48, 48).data;
  let ink = false;
  for (let i = 3; i < data.length && !ink; i += 4) ink = data[i] !== 0;
  if (inkCache.size > 8192) inkCache.clear();
  inkCache.set(key, ink);
  return ink;
}

/**
 * Which characters of a name can be drawn with its cosmetic font stack (for cleanCanvasName). A
 * face whose own "missing glyph" is blank would make the stack look like it supports everything,
 * so then a character counts when the face itself inks it or the base font stack supports it.
 */
export function cosmeticGlyphSupport(nameFont: NameFontStyle | undefined | null, sizePx: number, baseFont: string): GlyphSupport {
  const stack = cosmeticNameFont(nameFont, sizePx, baseFont);
  const def = nameFontDef(nameFont?.fontId);
  if (!def || stack === baseFont || canvasShowsNotdef(stack)) return canvasGlyphSupport(stack);
  const base = canvasGlyphSupport(baseFont);
  const face = nameFontFace(def.id);
  return (codePoint) => base(codePoint) || faceDrawsInk(face, codePoint);
}

/**
 * Draws a name in its cosmetic colour (solid, gradient, a static shimmer highlight, or neon) with
 * `font` (from cosmeticNameFont). Uses the context's textBaseline. Returns the drawn width.
 */
export function drawCosmeticName(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  options: { font: string; color?: NameColorStyle | null; defaultColor: string; sizePx: number; shadow?: boolean },
): number {
  ctx.save();
  ctx.font = options.font;
  ctx.textAlign = "left";
  const width = ctx.measureText(text).width;
  const color = options.color;
  const scale = deviceScale(ctx);
  if (options.shadow && color?.style !== "neon") {
    // Lifts the name off a busy background (an equipped background still).
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = options.sizePx * 0.25 * scale;
    ctx.shadowOffsetY = options.sizePx * 0.04 * scale;
  }
  if (!color) {
    ctx.fillStyle = options.defaultColor;
    ctx.fillText(text, x, y);
  } else if (color.style === "solid") {
    ctx.fillStyle = pick(color.colors, 0, options.defaultColor);
    ctx.fillText(text, x, y);
  } else if (color.style === "neon") {
    const base = pick(color.colors, 0, "#22e5ff");
    ctx.shadowColor = base;
    ctx.shadowBlur = options.sizePx * 0.55 * scale;
    ctx.fillStyle = mix(base, "#ffffff", 0.55);
    ctx.fillText(text, x, y);
    ctx.shadowBlur = options.sizePx * 0.18 * scale;
    ctx.fillText(text, x, y);
  } else {
    const gradient = ctx.createLinearGradient(x, y - options.sizePx * 0.8, x + Math.max(width, 1), y);
    const stops = color.colors.length >= 2 ? color.colors : [pick(color.colors, 0, "#ffffff"), "#ffffff"];
    stops.forEach((stop, index) => gradient.addColorStop(index / (stops.length - 1), stop));
    ctx.fillStyle = gradient;
    ctx.fillText(text, x, y);
    if (color.style === "shimmer") {
      ctx.shadowColor = "transparent";
      // The web animates the highlight; cards freeze it a little left of center.
      const shine = ctx.createLinearGradient(x, y - options.sizePx, x + Math.max(width, 1), y);
      shine.addColorStop(0, "rgba(255,255,255,0)");
      shine.addColorStop(0.32, "rgba(255,255,255,0)");
      shine.addColorStop(0.42, "rgba(255,255,255,0.75)");
      shine.addColorStop(0.52, "rgba(255,255,255,0)");
      shine.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shine;
      ctx.fillText(text, x, y);
    }
  }
  ctx.restore();
  return width;
}

/** The small title line under a name. Uses the context's textBaseline. */
export function drawCosmeticTitle(ctx: SKRSContext2D, title: TitleStyle, x: number, y: number, font: string, defaultColor: string, maxWidth?: number): number {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = title.color ?? defaultColor;
  let text = title.text;
  if (maxWidth !== undefined) {
    while (text.length > 1 && ctx.measureText(text).width > maxWidth) text = `${text.slice(0, -2)}…`;
  }
  ctx.fillText(text, x, y);
  const width = ctx.measureText(text).width;
  ctx.restore();
  return width;
}

/**
 * The icon after a name, centered on `centerY`. Emoji draw with `emojiFont`; returns the width
 * used (0 when nothing could be drawn, e.g. no emoji font on this machine).
 */
export async function drawNameIcon(
  ctx: SKRSContext2D,
  icon: IconStyle,
  x: number,
  centerY: number,
  size: number,
  options: { emojiFont: string; canDrawEmoji: (emoji: string) => boolean },
): Promise<number> {
  const image = await loadCosmeticImage(icon.imageUrl);
  if (image) {
    const fit = Math.min(size / image.width, size / image.height);
    ctx.drawImage(image, x + (size - image.width * fit) / 2, centerY - (image.height * fit) / 2, image.width * fit, image.height * fit);
    return size;
  }
  if (!icon.emoji || !options.canDrawEmoji(icon.emoji)) return 0;
  ctx.save();
  ctx.font = options.emojiFont;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  const width = ctx.measureText(icon.emoji).width;
  ctx.fillText(icon.emoji, x, centerY + size * 0.04);
  ctx.restore();
  return width;
}

// --- Backgrounds -----------------------------------------------------------------------------------

/** A soft coloured glow: one bloom at `focus`, a second (the next colour) across the card. */
export function drawGlow(ctx: SKRSContext2D, glow: GlowStyle, rect: Rect, focus: { x: number; y: number }): void {
  const intensity = Math.max(0.3, Math.min(1, glow.intensity));
  const reach = Math.max(rect.w, rect.h);
  ctx.save();
  const blooms: Array<{ x: number; y: number; r: number; color: string; alpha: number }> = [
    { x: focus.x, y: focus.y, r: reach * 0.55, color: pick(glow.colors, 0, "#6d78ff"), alpha: 0.6 * intensity },
    {
      x: rect.x + rect.w * (focus.x - rect.x < rect.w / 2 ? 0.85 : 0.15),
      y: rect.y + rect.h * 0.15,
      r: reach * 0.45,
      color: pick(glow.colors, 1, pick(glow.colors, 0, "#6d78ff")),
      alpha: 0.42 * intensity,
    },
  ];
  // "screen" brightens like light does, but can't blow a bright backdrop out to white.
  ctx.globalCompositeOperation = "screen";
  for (const bloom of blooms) {
    const gradient = ctx.createRadialGradient(bloom.x, bloom.y, 0, bloom.x, bloom.y, bloom.r);
    gradient.addColorStop(0, rgba(bloom.color, bloom.alpha));
    gradient.addColorStop(0.45, rgba(bloom.color, bloom.alpha * 0.45));
    gradient.addColorStop(1, rgba(bloom.color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
}

/**
 * An equipped background's still frame (rendered from the website's animation at this card's
 * size), cover-fit over `rect`. Returns false when there is no still yet or it can't be loaded,
 * so the card falls back to its normal backdrop.
 */
export async function drawBackgroundStill(ctx: SKRSContext2D, stillUrl: string | null | undefined, rect: Rect): Promise<boolean> {
  const image = await loadCosmeticImage(stillUrl, { large: true });
  if (!image || !image.width || !image.height) return false;
  drawCoverRegion(ctx, wholeImage(image), rect);
  return true;
}

/** A part of an image: a whole still, or one frame of a background's sprite sheet. */
export type ImageRegion = { image: Image | Canvas; sx: number; sy: number; sw: number; sh: number };

export function wholeImage(image: Image | Canvas): ImageRegion {
  return { image, sx: 0, sy: 0, sw: image.width, sh: image.height };
}

/** `region` cover-fit (centred) over `rect`, clipped to it. */
export function drawCoverRegion(ctx: SKRSContext2D, region: ImageRegion, rect: Rect): void {
  if (!region.sw || !region.sh) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  const cover = Math.max(rect.w / region.sw, rect.h / region.sh);
  const w = region.sw * cover;
  const h = region.sh * cover;
  ctx.drawImage(region.image, region.sx, region.sy, region.sw, region.sh, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
  ctx.restore();
}

// --- Avatar frames ---------------------------------------------------------------------------------

export type AvatarBox = { x: number; y: number; size: number; radius: number };

/**
 * A frame around an avatar (a rounded square, or a circle when radius >= size / 2): uploaded
 * frame art laid over it, or a procedural preset hugging its outline.
 */
export async function drawAvatarFrame(ctx: SKRSContext2D, frame: FrameStyle, box: AvatarBox, seed = "frame"): Promise<void> {
  const image = await loadCosmeticImage(frame.imageUrl);
  const { x, y, size } = box;
  const radius = Math.min(box.radius, size / 2);
  if (image) {
    const s = size * 1.32;
    const fit = Math.min(s / image.width, s / image.height);
    ctx.drawImage(image, x + size / 2 - (image.width * fit) / 2, y + size / 2 - (image.height * fit) / 2, image.width * fit, image.height * fit);
    return;
  }
  const scale = deviceScale(ctx);
  const unit = size / 64; // sizes below are tuned on the 64px card avatars
  const gap = 2 * unit;
  const fx = x - gap;
  const fy = y - gap;
  const fs = size + gap * 2;
  const fr = radius + gap;
  const c0 = pick(frame.colors, 0, "#22e5ff");
  const c1 = pick(frame.colors, 1, c0);
  const random = seededRandom(`${seed}:${frame.preset}`);
  const ring = (width: number, style: string | import("@napi-rs/canvas").CanvasGradient) => {
    ctx.strokeStyle = style as string;
    ctx.lineWidth = width;
    roundRectPath(ctx, fx, fy, fs, fs, fr);
    ctx.stroke();
  };
  const diagonal = (stops: string[]) => {
    const gradient = ctx.createLinearGradient(fx, fy, fx + fs, fy + fs);
    stops.forEach((stop, index) => gradient.addColorStop(index / (stops.length - 1), stop));
    return gradient;
  };

  ctx.save();
  switch (frame.preset) {
    case "neon": {
      ctx.shadowColor = c0;
      ctx.shadowBlur = 9 * unit * scale;
      ring(2.6 * unit, diagonal([c0, c1, c0]));
      ctx.shadowBlur = 4 * unit * scale;
      ring(2.6 * unit, diagonal([c0, c1, c0]));
      ctx.shadowBlur = 0;
      ring(0.9 * unit, "rgba(255,255,255,0.75)");
      break;
    }
    case "gold": {
      const light = mix(c0, "#ffffff", 0.45);
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 3 * unit * scale;
      ring(4 * unit, diagonal([light, c1, c0, light, c1]));
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 0.7 * unit;
      roundRectPath(ctx, fx - 1.4 * unit, fy - 1.4 * unit, fs + 2.8 * unit, fs + 2.8 * unit, fr + 1.4 * unit);
      ctx.stroke();
      ctx.strokeStyle = "rgba(60,40,0,0.5)";
      roundRectPath(ctx, fx + 1.4 * unit, fy + 1.4 * unit, fs - 2.8 * unit, fs - 2.8 * unit, Math.max(0, fr - 1.4 * unit));
      ctx.stroke();
      // Four studs, at the middle of each side.
      for (const [sx, sy] of [[fx + fs / 2, fy], [fx + fs, fy + fs / 2], [fx + fs / 2, fy + fs], [fx, fy + fs / 2]] as const) {
        ctx.fillStyle = diagonal([light, c0, c1]);
        starPath(ctx, sx, sy, 3.2 * unit, 4, 0.5, 0);
        ctx.fill();
      }
      break;
    }
    case "frost": {
      ctx.shadowColor = rgba(c0, 0.9);
      ctx.shadowBlur = 6 * unit * scale;
      ring(3 * unit, diagonal([mix(c0, "#ffffff", 0.3), c1, "#ffffff", c0]));
      ctx.shadowBlur = 3 * unit * scale;
      ctx.shadowColor = "rgba(255,255,255,0.9)";
      for (let i = 0; i < 7; i++) {
        const p = perimeterPoint(fx, fy, fs, fs, fr, i / 7 + random() * 0.05);
        ctx.fillStyle = "#ffffff";
        sparklePath(ctx, p.x, p.y, (2.4 + random() * 2.4) * unit);
        ctx.fill();
      }
      break;
    }
    case "hearts": {
      ring(2.2 * unit, diagonal([c0, c1, c0]));
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 2 * unit * scale;
      for (let i = 0; i < 8; i++) {
        const p = perimeterPoint(fx, fy, fs, fs, fr, i / 8 + 0.03);
        ctx.fillStyle = i % 2 === 0 ? c0 : mix(c1, "#ffffff", 0.15);
        heartPath(ctx, p.x, p.y, (i % 2 === 0 ? 7.5 : 5.5) * unit);
        ctx.fill();
      }
      break;
    }
    case "flames": {
      // Tongues of flame licking outward, then the ring on top.
      const tongues = 22;
      for (let i = 0; i < tongues; i++) {
        const p = perimeterPoint(fx, fy, fs, fs, fr, i / tongues + random() * 0.01);
        const length = (5 + random() * 6) * unit * (Math.sin(p.angle) < 0 ? 1.15 : 0.85);
        const half = (2.4 + random() * 1.4) * unit;
        const tip = { x: p.x + Math.cos(p.angle) * length, y: p.y + Math.sin(p.angle) * length };
        const side = p.angle + Math.PI / 2;
        const gradient = ctx.createLinearGradient(p.x, p.y, tip.x, tip.y);
        gradient.addColorStop(0, c0);
        gradient.addColorStop(0.65, c1);
        gradient.addColorStop(1, rgba(c1, 0));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(p.x + Math.cos(side) * half, p.y + Math.sin(side) * half);
        ctx.quadraticCurveTo(p.x + Math.cos(p.angle) * length * 0.55 + Math.cos(side) * half * 0.6, p.y + Math.sin(p.angle) * length * 0.55 + Math.sin(side) * half * 0.6, tip.x, tip.y);
        ctx.quadraticCurveTo(p.x + Math.cos(p.angle) * length * 0.55 - Math.cos(side) * half * 0.6, p.y + Math.sin(p.angle) * length * 0.55 - Math.sin(side) * half * 0.6, p.x - Math.cos(side) * half, p.y - Math.sin(side) * half);
        ctx.closePath();
        ctx.fill();
      }
      ctx.shadowColor = c0;
      ctx.shadowBlur = 5 * unit * scale;
      ring(2.6 * unit, diagonal([c0, c1, c0, c1]));
      break;
    }
    case "stars": {
      ring(2 * unit, diagonal([c0, c1, c0]));
      ctx.shadowColor = rgba(c0, 0.9);
      ctx.shadowBlur = 4 * unit * scale;
      for (let i = 0; i < 6; i++) {
        const p = perimeterPoint(fx, fy, fs, fs, fr, i / 6 + 0.04);
        ctx.fillStyle = i % 2 === 0 ? c0 : c1;
        starPath(ctx, p.x, p.y, (i % 2 === 0 ? 5.2 : 3.8) * unit, 5, 0.46, -Math.PI / 2 + random() * 0.4);
        ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

// --- Bars, rings and flair ---------------------------------------------------------------------------

/** The share ring's progress arc (the track is the caller's), in the bar cosmetic's style. */
export function drawShareRingProgress(
  ctx: SKRSContext2D,
  bar: BarStyle | undefined | null,
  ring: { cx: number; cy: number; r: number; stroke: number; pct: number; accent: string },
): void {
  const pct = Math.max(0, Math.min(100, ring.pct));
  if (pct <= 0) return;
  const start = -Math.PI / 2;
  const end = start + (pct / 100) * Math.PI * 2;
  const scale = deviceScale(ctx);
  ctx.save();
  ctx.lineWidth = ring.stroke;
  ctx.lineCap = "round";
  if (!bar) {
    ctx.strokeStyle = ring.accent;
  } else if (bar.style === "gradient") {
    const gradient = ctx.createConicGradient(start, ring.cx, ring.cy);
    const stops = bar.colors.length >= 2 ? bar.colors : [pick(bar.colors, 0, ring.accent), mix(pick(bar.colors, 0, ring.accent), "#ffffff", 0.5)];
    const span = Math.max(0.05, pct / 100);
    stops.forEach((stop, index) => gradient.addColorStop((index / (stops.length - 1)) * span, stop));
    gradient.addColorStop(Math.min(1, span + 0.001), stops[stops.length - 1]!);
    ctx.strokeStyle = gradient;
  } else if (bar.style === "striped") {
    ctx.lineCap = "butt";
    ctx.strokeStyle = pick(bar.colors, 0, ring.accent);
    ctx.beginPath();
    ctx.arc(ring.cx, ring.cy, ring.r, start, end);
    ctx.stroke();
    ctx.strokeStyle = pick(bar.colors, 1, mix(pick(bar.colors, 0, ring.accent), "#ffffff", 0.6));
    ctx.setLineDash([ring.stroke * 0.9, ring.stroke * 0.9]);
  } else {
    const color = pick(bar.colors, 0, ring.accent);
    ctx.strokeStyle = mix(color, "#ffffff", 0.25);
    ctx.shadowColor = color;
    ctx.shadowBlur = ring.stroke * 2.2 * scale;
  }
  ctx.beginPath();
  ctx.arc(ring.cx, ring.cy, ring.r, start, end);
  ctx.stroke();
  ctx.restore();
}

/** A linear share bar's fill (the track is the caller's), in the bar cosmetic's style. */
export function drawShareBarFill(
  ctx: SKRSContext2D,
  bar: BarStyle | undefined | null,
  rect: { x: number; y: number; w: number; h: number; fillW: number; radius: number; accent: string },
): void {
  if (rect.fillW <= 0) return;
  const scale = deviceScale(ctx);
  ctx.save();
  roundRectPath(ctx, rect.x, rect.y, rect.fillW, rect.h, rect.radius);
  if (!bar) {
    ctx.fillStyle = rect.accent;
    ctx.fill();
  } else if (bar.style === "gradient") {
    const gradient = ctx.createLinearGradient(rect.x, 0, rect.x + rect.fillW, 0);
    const stops = bar.colors.length >= 2 ? bar.colors : [pick(bar.colors, 0, rect.accent), mix(pick(bar.colors, 0, rect.accent), "#ffffff", 0.5)];
    stops.forEach((stop, index) => gradient.addColorStop(index / (stops.length - 1), stop));
    ctx.fillStyle = gradient;
    ctx.fill();
  } else if (bar.style === "striped") {
    ctx.fillStyle = pick(bar.colors, 0, rect.accent);
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = pick(bar.colors, 1, mix(pick(bar.colors, 0, rect.accent), "#ffffff", 0.6));
    ctx.lineWidth = rect.h * 0.7;
    for (let sx = rect.x - rect.h * 2; sx < rect.x + rect.fillW + rect.h * 2; sx += rect.h * 2.2) {
      ctx.beginPath();
      ctx.moveTo(sx, rect.y + rect.h + 1);
      ctx.lineTo(sx + rect.h * 1.4, rect.y - 1);
      ctx.stroke();
    }
  } else {
    const color = pick(bar.colors, 0, rect.accent);
    ctx.shadowColor = color;
    ctx.shadowBlur = rect.h * 1.6 * scale;
    ctx.fillStyle = mix(color, "#ffffff", 0.2);
    ctx.fill();
  }
  ctx.restore();
}

/** Leaderboard flair on a row: a coloured glow and tint, or a diagonal shimmer highlight. */
export function drawRowFlair(ctx: SKRSContext2D, flair: FlairStyle, rect: Rect, radius: number): void {
  const scale = deviceScale(ctx);
  ctx.save();
  if (flair.style === "glow") {
    ctx.shadowColor = rgba(flair.color, 0.75);
    ctx.shadowBlur = 14 * scale;
    ctx.strokeStyle = rgba(flair.color, 0.85);
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
    ctx.stroke();
    ctx.shadowBlur = 0;
    const tint = ctx.createLinearGradient(rect.x, 0, rect.x + rect.w, 0);
    tint.addColorStop(0, rgba(flair.color, 0.16));
    tint.addColorStop(1, rgba(flair.color, 0.03));
    ctx.fillStyle = tint;
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
    ctx.fill();
  } else {
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
    ctx.clip();
    const shine = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    shine.addColorStop(0, rgba(flair.color, 0.04));
    shine.addColorStop(0.3, rgba(flair.color, 0.08));
    shine.addColorStop(0.38, rgba(flair.color, 0.2));
    shine.addColorStop(0.46, rgba(flair.color, 0.08));
    shine.addColorStop(1, rgba(flair.color, 0.04));
    ctx.fillStyle = shine;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = rgba(flair.color, 0.55);
    ctx.lineWidth = 2;
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
    ctx.stroke();
  }
  ctx.restore();
}
