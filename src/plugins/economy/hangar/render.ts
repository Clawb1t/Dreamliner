import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { loadImageSafe } from "../../../core/safeImage.js";
import type { PlaneTypeRow } from "../functions/catalog.js";
import { planeImagePath } from "../functions/images.js";
import { LIVERY_META, MAX_LEVEL, RARITY_META, type Livery, type Rarity } from "./constants.js";
import { effectiveStats } from "./flights.js";
import { serialLabel } from "./view.js";

/**
 * Card faces drawn with @napi-rs/canvas: the art from assets/planes/ on a flat card body (no border), a
 * livery treatment (gold foil, blueprint prototype), then the name with its rarity / livery / First
 * Edition tags, stats, serial and level pips. The art already carries the Dreamliner logo, so the
 * face doesn't add another. Flat colours only.
 *
 * Two caches: the face without a serial, keyed by (type, art version, livery, edition, level), and
 * the finished per-copy PNG with its serial drawn on. The web image endpoint and Discord share both.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FONT_DIR = join(ROOT, "assets", "fonts");

export const CARD_WIDTH = 640;
export const CARD_HEIGHT = 1160;

const ART = { x: 14, y: 14, w: 612, h: 870, r: 26 };

let fontsReady = false;
let family = "sans-serif";

function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  const faces: [string, string][] = [
    ["PlusJakartaSans-750.ttf", "Hangar Bold"],
    ["PlusJakartaSans-650.ttf", "Hangar SemiBold"],
    ["PlusJakartaSans-500.ttf", "Hangar"],
  ];
  let ok = false;
  for (const [file, face] of faces) {
    const path = join(FONT_DIR, file);
    if (!existsSync(path)) continue;
    try {
      GlobalFonts.registerFromPath(path, face);
      ok = true;
    } catch {
      /* fall back below */
    }
  }
  family = ok ? "Hangar" : "sans-serif";
}

function font(weight: "bold" | "semi" | "regular", size: number): string {
  if (family === "sans-serif") return `${weight === "regular" ? "" : "bold "}${size}px sans-serif`;
  const face = weight === "bold" ? "Hangar Bold" : weight === "semi" ? "Hangar SemiBold" : "Hangar";
  return `${size}px "${face}"`;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The Dreamliner plane mark, centred on (x, y), about 2s tall. */
function planeMark(ctx: SKRSContext2D, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  // fuselage
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x + s * 0.14, y - s * 0.85, x + s * 0.14, y - s * 0.6);
  ctx.lineTo(x + s * 0.14, y + s * 0.7);
  ctx.lineTo(x - s * 0.14, y + s * 0.7);
  ctx.lineTo(x - s * 0.14, y - s * 0.6);
  ctx.quadraticCurveTo(x - s * 0.14, y - s * 0.85, x, y - s);
  ctx.closePath();
  ctx.fill();
  // wings
  ctx.beginPath();
  ctx.moveTo(x - s, y + s * 0.15);
  ctx.lineTo(x, y - s * 0.35);
  ctx.lineTo(x + s, y + s * 0.15);
  ctx.lineTo(x + s, y + s * 0.32);
  ctx.lineTo(x, y + s * 0.05);
  ctx.lineTo(x - s, y + s * 0.32);
  ctx.closePath();
  ctx.fill();
  // tail
  ctx.beginPath();
  ctx.moveTo(x - s * 0.42, y + s * 0.9);
  ctx.lineTo(x, y + s * 0.62);
  ctx.lineTo(x + s * 0.42, y + s * 0.9);
  ctx.lineTo(x + s * 0.42, y + s);
  ctx.lineTo(x, y + s * 0.85);
  ctx.lineTo(x - s * 0.42, y + s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

type Theme = { frame: string; body: string; panel: string; text: string; muted: string; bar: string; barBg: string };

function themeFor(rarity: Rarity, livery: Livery): Theme {
  const rarityColor = hex(RARITY_META[rarity].color);
  if (livery === "gold") {
    return { frame: hex(LIVERY_META.gold.color), body: "#231d0f", panel: "#2c2412", text: "#fff6dc", muted: "#d9c38a", bar: "#e8c15a", barBg: "#3d331b" };
  }
  if (livery === "prototype") {
    return { frame: "#7fb2ff", body: "#0d2a52", panel: "#11335f", text: "#eaf3ff", muted: "#9cc0f0", bar: "#9cc8ff", barBg: "#1b4377" };
  }
  return { frame: rarityColor, body: "#15171c", panel: "#1c1f26", text: "#f4f6fa", muted: "#9aa4b2", bar: rarityColor, barBg: "#2a2e37" };
}

const artCache = new Map<string, Image | null>();

async function loadArt(imageKey: string): Promise<Image | null> {
  if (artCache.has(imageKey)) return artCache.get(imageKey)!;
  const path = imageKey ? planeImagePath(imageKey) : null;
  let image: Image | null = null;
  if (path && existsSync(path)) {
    try {
      image = await loadImageSafe(readFileSync(path));
    } catch {
      image = null;
    }
  }
  if (artCache.size > 200) artCache.clear();
  artCache.set(imageKey, image);
  return image;
}

/** Forget cached art for an image key (after an upload replaces it). */
export function invalidateArt(imageKey?: string): void {
  if (imageKey) artCache.delete(imageKey);
  else artCache.clear();
  faceCache.clear();
  copyCache.clear();
}

function drawArt(ctx: SKRSContext2D, art: Image | null, card: PlaneTypeRow, theme: Theme, livery: Livery): void {
  ctx.save();
  roundRect(ctx, ART.x, ART.y, ART.w, ART.h, ART.r);
  ctx.clip();
  ctx.fillStyle = theme.body;
  ctx.fillRect(ART.x, ART.y, ART.w, ART.h);
  if (art) {
    const scale = Math.max(ART.w / art.width, ART.h / art.height);
    const w = art.width * scale;
    const h = art.height * scale;
    ctx.drawImage(art, ART.x + (ART.w - w) / 2, ART.y + (ART.h - h) / 2, w, h);
  } else {
    planeMark(ctx, ART.x + ART.w / 2, ART.y + ART.h / 2 - 40, 90, theme.muted);
    ctx.fillStyle = theme.text;
    ctx.font = font("bold", 40);
    ctx.textAlign = "center";
    ctx.fillText(card.name, ART.x + ART.w / 2, ART.y + ART.h / 2 + 110, ART.w - 40);
  }
  if (livery === "prototype") {
    // Blueprint: a blue wash and a fine grid over the art.
    ctx.fillStyle = "rgba(13, 42, 82, 0.55)";
    ctx.fillRect(ART.x, ART.y, ART.w, ART.h);
    ctx.strokeStyle = "rgba(156, 200, 255, 0.22)";
    ctx.lineWidth = 1;
    for (let x = ART.x; x <= ART.x + ART.w; x += 26) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, ART.y);
      ctx.lineTo(x + 0.5, ART.y + ART.h);
      ctx.stroke();
    }
    for (let y = ART.y; y <= ART.y + ART.h; y += 26) {
      ctx.beginPath();
      ctx.moveTo(ART.x, y + 0.5);
      ctx.lineTo(ART.x + ART.w, y + 0.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The card body: one flat colour edge to edge, no border (rarity and livery show as tags). */
function drawFrame(ctx: SKRSContext2D, theme: Theme): void {
  roundRect(ctx, 0, 0, CARD_WIDTH, CARD_HEIGHT, 32);
  ctx.fillStyle = theme.body;
  ctx.fill();
}

const PILL_H = 30;

function pillWidth(ctx: SKRSContext2D, text: string): number {
  ctx.font = font("bold", 16);
  return ctx.measureText(text).width + 22;
}

/** A small tag; `y` is its top edge. Returns its width. */
function pill(ctx: SKRSContext2D, x: number, y: number, text: string, bg: string, fg: string): number {
  const w = pillWidth(ctx, text);
  roundRect(ctx, x, y, w, PILL_H, PILL_H / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = font("bold", 16);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 11, y + PILL_H / 2 + 1);
  ctx.textBaseline = "alphabetic";
  return w;
}

function statRows(card: PlaneTypeRow, level: number): { label: string; value: string; fill: number }[] {
  const s = effectiveStats(card, level);
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (card.cardType === "airline") {
    return [
      { label: "Reputation", value: String(s.reputation), fill: s.reputation / 100 },
      { label: "Safety", value: String(s.safety), fill: s.safety / 100 },
      { label: "Fleet", value: fmt(s.fleetSize), fill: Math.min(1, s.fleetSize / 1000) },
      { label: "Destinations", value: fmt(s.destinations), fill: Math.min(1, s.destinations / 400) },
    ];
  }
  return [
    { label: "Speed", value: String(s.speed), fill: s.speed / 100 },
    { label: "Agility", value: String(s.agility), fill: s.agility / 100 },
    { label: "Safety", value: String(s.safety), fill: s.safety / 100 },
    { label: "Passengers", value: fmt(s.passengerCount), fill: Math.min(1, s.passengerCount / 600) },
  ];
}

export type FaceInput = { card: PlaneTypeRow; livery: Livery; firstEdition: boolean; level: number };

async function drawFace(input: FaceInput): Promise<Buffer> {
  ensureFonts();
  const rarity = (input.card.rarity in RARITY_META ? input.card.rarity : "common") as Rarity;
  const livery = input.livery in LIVERY_META ? input.livery : "standard";
  const theme = themeFor(rarity, livery);
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext("2d");

  drawFrame(ctx, theme);
  drawArt(ctx, await loadArt(input.card.imageKey), input.card, theme, livery);

  // Name with its tags beside it (rarity, then livery and First Edition), level on the right.
  const px = 40;
  let y = ART.y + ART.h + 50;
  const tags: { text: string; bg: string; fg: string }[] = [
    { text: RARITY_META[rarity].label.toUpperCase(), bg: hex(RARITY_META[rarity].color), fg: "#ffffff" },
  ];
  if (livery !== "standard") {
    tags.push({ text: LIVERY_META[livery].label.toUpperCase(), bg: theme.frame, fg: livery === "gold" ? "#2a2008" : "#0d2a52" });
  }
  if (input.firstEdition) tags.push({ text: "FIRST EDITION", bg: theme.text, fg: theme.body });
  ctx.font = font("semi", 22);
  const levelText = `LV ${input.level}`;
  const levelW = ctx.measureText(levelText).width;
  const tagGap = 8;
  const tagsW = tags.reduce((sum, t) => sum + pillWidth(ctx, t.text) + tagGap, 0);
  const nameRoom = CARD_WIDTH - px * 2 - levelW - 16 - tagsW;
  ctx.font = font("bold", 32);
  // Tags that don't fit beside the name move to the subtitle line.
  const fitsBeside = ctx.measureText(input.card.name).width <= nameRoom;
  const nameMax = fitsBeside ? nameRoom : CARD_WIDTH - px * 2 - levelW - 16;
  ctx.textAlign = "left";
  ctx.fillStyle = theme.text;
  ctx.fillText(input.card.name, px, y, nameMax);
  const drawTags = (startX: number, baseline: number) => {
    let tx = startX;
    for (const tag of tags) tx += pill(ctx, tx, baseline - 23, tag.text, tag.bg, tag.fg) + tagGap;
  };
  if (fitsBeside) {
    ctx.font = font("bold", 32);
    drawTags(px + Math.min(ctx.measureText(input.card.name).width, nameMax) + 14, y);
  }
  ctx.textAlign = "right";
  ctx.fillStyle = theme.muted;
  ctx.font = font("semi", 22);
  ctx.fillText(levelText, CARD_WIDTH - px, y);
  y += 32;
  ctx.textAlign = "left";
  ctx.font = font("regular", 19);
  ctx.fillStyle = theme.muted;
  const subtitle = input.card.subtitle || (input.card.cardType === "airline" ? "Airline" : "Aircraft");
  if (fitsBeside) {
    ctx.fillText(subtitle, px, y, CARD_WIDTH - px * 2);
  } else {
    drawTags(px, y + 2);
    ctx.font = font("regular", 19);
    ctx.fillStyle = theme.muted;
    ctx.fillText(subtitle, px + tagsW + 4, y, Math.max(80, CARD_WIDTH - px * 2 - tagsW - 4));
  }

  // Stats: two columns of label, value and a flat bar.
  const rows = statRows(input.card, input.level);
  const colW = (CARD_WIDTH - px * 2 - 24) / 2;
  y += 22;
  rows.forEach((row, i) => {
    const cx = px + (i % 2) * (colW + 24);
    const cy = y + Math.floor(i / 2) * 50;
    ctx.fillStyle = theme.muted;
    ctx.font = font("semi", 16);
    ctx.textAlign = "left";
    ctx.fillText(row.label.toUpperCase(), cx, cy + 16);
    ctx.fillStyle = theme.text;
    ctx.textAlign = "right";
    ctx.fillText(row.value, cx + colW, cy + 16);
    roundRect(ctx, cx, cy + 26, colW, 8, 4);
    ctx.fillStyle = theme.barBg;
    ctx.fill();
    roundRect(ctx, cx, cy + 26, Math.max(8, colW * Math.max(0, Math.min(1, row.fill))), 8, 4);
    ctx.fillStyle = theme.bar;
    ctx.fill();
  });

  // Footer: level pips on the right (the serial is drawn per copy on the left).
  const fy = CARD_HEIGHT - 36;
  const pipsW = MAX_LEVEL * 16;
  const pipsX = CARD_WIDTH - px - pipsW + 6;
  for (let i = 0; i < MAX_LEVEL; i++) {
    ctx.beginPath();
    ctx.arc(pipsX + i * 16, fy - 6, 5, 0, Math.PI * 2);
    ctx.fillStyle = i < input.level ? theme.bar : theme.barBg;
    ctx.fill();
  }

  return canvas.toBuffer("image/png");
}

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const faceCache = new Lru<Promise<Buffer>>(300);
const copyCache = new Lru<Promise<Buffer>>(600);

function faceKey(input: FaceInput): string {
  return `${input.card.id}:${input.card.updatedAt.getTime()}:${input.card.imageKey}:${input.livery}:${input.firstEdition ? 1 : 0}:${input.level}`;
}

/** A card face without a serial (catalog views, type renders). Cached. */
export function renderFace(input: FaceInput): Promise<Buffer> {
  const key = faceKey(input);
  const hit = faceCache.get(key);
  if (hit) return hit;
  const work = drawFace(input).catch((error) => {
    faceCache.delete(key);
    throw error;
  });
  faceCache.set(key, work);
  return work;
}

/** One copy's face with its serial ("#0042/500"). Cached per copy state. */
export function renderCopy(input: FaceInput & { serial: number }): Promise<Buffer> {
  const key = `${faceKey(input)}:${input.serial}`;
  const hit = copyCache.get(key);
  if (hit) return hit;
  const work = (async () => {
    ensureFonts();
    const base = await loadImageSafe(await renderFace(input));
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(base, 0, 0);
    const livery = input.livery in LIVERY_META ? input.livery : "standard";
    const rarity = (input.card.rarity in RARITY_META ? input.card.rarity : "common") as Rarity;
    const theme = themeFor(rarity, livery);
    ctx.textAlign = "left";
    ctx.fillStyle = theme.text;
    ctx.font = font("bold", 20);
    ctx.fillText(serialLabel(input.serial, input.card.printRun ?? null), 40, CARD_HEIGHT - 36);
    return canvas.toBuffer("image/png");
  })();
  copyCache.set(key, work);
  work.catch(() => copyCache.delete(key));
  return work;
}
