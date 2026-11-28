import { loadImageSafe } from "../../../core/safeImage.js";
import { createCanvas, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { Client, User } from "discord.js";
import { siteFont } from "../../welcome_message/functions/cardFonts.js";
import { canvasGlyphSupport, cleanCanvasName, firstGrapheme, stripUnsupportedGlyphs, truncateToFit } from "../../../core/canvasText.js";
import { colorMix, ensureEmojiFont, loadImageMaybeDataUri, roundRect, tintedImage, type CardLayers, type CardMode } from "./charts.js";
import { getUserProfile } from "../../../bridge/userProfiles.js";
import { dailyActivityFor, dailyVoiceFor, firstSeenFor, globalEconomyFor, globalStatsFor, hourlyActivityFor } from "../../../core/privacy/crossServer.js";
import { canViewCrossServerData } from "../../../core/privacy/ghostMode.js";
import { filterBadgesForAccess } from "../../../core/privacy/policy.js";
import { getProgressionBadges, loadBadgeImage } from "../../../core/progressionBadges/index.js";
import { getLogger } from "../../../core/logger.js";

const profileLog = getLogger("profile-card");

/**
 * Resolves to `fallback` (and logs which step it was) if `work` hasn't settled within `ms`, so one
 * stalled network call (Discord's user fetch, a badge metric, an avatar download) can never leave
 * /profile "thinking" forever. The step keeps running in the background; its result is ignored.
 */
async function withTimeout<T>(step: string, ms: number, work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      profileLog.warn(`[profile] ${step} took over ${ms}ms; continuing without it`);
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([work.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
import { getEquippedStyle } from "../../../core/cosmetics/equip.js";
import type { CosmeticStyle } from "../../../core/cosmetics/types.js";
import { animatedCardKey, cachedAnimatedCard, hasBackgroundFrames, renderAnimatedProfileCard } from "./animatedCards.js";
import {
  cosmeticGlyphSupport,
  cosmeticNameFont,
  drawAvatarFrame,
  drawCosmeticName,
  drawCosmeticTitle,
  drawGlow,
  drawNameIcon,
  drawCoverRegion,
  drawTextWithEmoji,
  loadCosmeticImage,
  rgba,
  wholeImage,
  type ImageRegion,
} from "../../../core/cosmetics/canvas.js";
import { hasTwemoji } from "../../../core/twemoji.js";

const log = getLogger("stats");

/**
 * The /profile card, laid out like Discord's full profile popout and the profile page on the site:
 * one rounded container with the profile panel on the left (banner, overlapping round avatar,
 * name, badges, labelled sections) and, on the right, the page's tab bar followed by stacked
 * cards (stats, activity, highlights). Drawn in card units, then at 3x for a crisp image.
 */

const REM = 16;
const SITE = {
  surface: "#141417", // --surface (dark)
  surfaceMuted: "#1a1a21", // --surface-muted (dark)
  foreground: "#f4f4f5", // --foreground (dark)
  muted: "#9a9aa5", // --muted (dark)
  dashTrack: "#222229", // --dash-track (dark)
  container: "#0d0d10", // the outer container, a step below --surface
  panel: "#16161b", // the profile panel
  card: "#1c1c22", // cards in the right column
  chip: "#25252d", // chips and tiles on panels/cards
  defaultAccent: "#5662f5", // the site's fallback when no accent can be worked out
  online: "#23a55a", // .profile-last-seen.is-active dot
};

const ACTIVE_NOW_WINDOW_MS = 5 * 60 * 1000;

export type ProfileCardBadge = {
  name: string;
  icon: string;
  iconImageUrl: string | null;
  colorHex: string | null;
};

export type ProfileCardData = {
  displayName: string;
  username: string;
  avatarURL: string | null;
  bannerURL: string | null;
  /** The profile accent (#hex or rgb()); the One bolt and uncolored chips use it. */
  accent: string;
  /** Progression badge art in display order; `tint` recolors single-color art (the One bolt).
   *  Named ones are also listed on the Highlights card. */
  progressionIcons: Array<{
    image: Buffer;
    tint?: string;
    sizeRem: number;
    /** Badge key, e.g. "dreamliner_one". */
    id?: string;
    name?: string;
    tierName?: string | null;
    /** ISO time it was earned or assigned, when known. */
    since?: string | null;
  }>;
  badges: ProfileCardBadge[];
  lastActiveAt: Date | null;
  now?: Date;
  /** Equipped store cosmetics (background, glow, frame, name font/colour, title, icon). */
  cosmetics?: CosmeticStyle | null;
  /** When the Discord account was created (public, from the user id). */
  accountCreatedAt?: Date | null;
  /** First UTC day Dreamliner saw them anywhere ("YYYY-MM-DD"), as this viewer may see it. */
  firstSeenAt?: string | null;
  /** ISO time they've had Dreamliner One since, from its progression badge. */
  oneSince?: string | null;
  /** The user's Discord avatar decoration (static PNG URL), drawn over the avatar. Null when they
   *  have none or turned it off in their profile settings. */
  avatarDecorationURL?: string | null;
  /** Cross-server numbers exactly as this viewer may see them. Absent: no stats cards. */
  stats?: ProfileStatsSummary | null;
};

/** "3h ago" style, same thresholds as the site's ProfileLastSeen. */
export function formatAgo(diffMs: number): string {
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function lastSeenLabel(lastActiveAt: Date | null, now: Date): { text: string; active: boolean } | null {
  if (!lastActiveAt) return null;
  const diffMs = Math.max(0, now.getTime() - lastActiveAt.getTime());
  const active = diffMs <= ACTIVE_NOW_WINDOW_MS;
  return { text: active ? "Active now" : `Last seen ${formatAgo(diffMs)}`, active };
}

/** The site's avatar accent: the most saturated color region of a 32x32 sample (same rules as
 *  dominantColorFromImageUrl on the website), or the fallback. */
export function dominantColor(image: Image | Canvas, fallback = SITE.defaultAccent): string {
  const sample = createCanvas(32, 32);
  const ctx = sample.getContext("2d");
  const cover = Math.max(32 / image.width, 32 / image.height);
  const w = image.width * cover;
  const h = image.height * cover;
  ctx.drawImage(image, (32 - w) / 2, (32 - h) / 2, w, h);
  const data = ctx.getImageData(0, 0, 32, 32).data;
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    if (a < 200) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 28 || min > 235) continue;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else buckets.set(key, { count: 1, r, g, b });
  }
  const total = [...buckets.values()].reduce((sum, bucket) => sum + bucket.count, 0);
  const minPresence = Math.max(2, Math.round(total * 0.01));
  type Bucket = { count: number; r: number; g: number; b: number };
  let best: Bucket | null = null;
  let bestSaturation = -1;
  let mostFrequent: Bucket | null = null;
  for (const bucket of buckets.values()) {
    if (!mostFrequent || bucket.count > mostFrequent.count) mostFrequent = bucket;
    if (bucket.count < minPresence) continue;
    const r = bucket.r / bucket.count;
    const g = bucket.g / bucket.count;
    const b = bucket.b / bucket.count;
    const max = Math.max(r, g, b);
    const saturation = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
    if (saturation > 0.15 && saturation > bestSaturation) {
      bestSaturation = saturation;
      best = bucket;
    }
  }
  const pick: Bucket | null = best ?? mostFrequent;
  if (!pick) return fallback;
  const hex = (value: number) => Math.round(value / pick.count).toString(16).padStart(2, "0");
  return `#${hex(pick.r)}${hex(pick.g)}${hex(pick.b)}`;
}

/** Any CSS color we produce (#hex or rgb()) as #rrggbb, for the color helpers. */
function toHex(color: string): string {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  if (!rgb) return color;
  return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  return truncateToFit(text, (candidate) => ctx.measureText(candidate).width <= maxWidth);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "21 Jan 2017" (UTC), the date style of Discord's "Member Since". Null for a missing/bad date. */
export function formatProfileDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** A Discord avatar decoration URL as a static PNG at `size` (passthrough=false: no animation). */
export function staticDecorationUrl(url: string | null | undefined, size = 240): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("size", String(size));
    parsed.searchParams.set("passthrough", "false");
    return parsed.toString();
  } catch {
    return null;
  }
}

/** How old a 00:00 UTC snapshot is, in whole hours: "as of 3h ago", or "as of less than 1h ago". */
export function snapshotAgeLabel(asOf: string | Date, now: Date): string {
  const at = typeof asOf === "string" ? new Date(asOf) : asOf;
  const hours = Math.floor(Math.max(0, now.getTime() - at.getTime()) / 3_600_000);
  return Number.isNaN(hours) || hours < 1 ? "as of less than 1h ago" : `as of ${hours}h ago`;
}

/** "45m", "3h 20m", "128h" (voice time on the Activity card). */
export function formatVoiceMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours >= 100 || rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export type ActivitySummary = {
  /** The last `window` days, oldest first. */
  days: number[];
  total: number;
  average: number;
  activeDays: number;
  best: number;
  /** Index of the best day in `days` (the latest one on a tie). */
  bestIndex: number;
  /** Whole-percent change on the `window` days before, when there are enough days and the
   *  earlier period had any messages. */
  changePct: number | null;
};

/** The Activity card's numbers from messages per day (oldest first). Null with under 2 days. */
export function summarizeActivity(daily: readonly number[], window: number): ActivitySummary | null {
  const days = daily.slice(-window);
  if (days.length < 2) return null;
  const total = days.reduce((sum, value) => sum + value, 0);
  let bestIndex = 0;
  for (const [index, value] of days.entries()) if (value >= days[bestIndex]!) bestIndex = index;
  const before = daily.length >= window * 2 ? daily.slice(-window * 2, -window) : null;
  const previous = before ? before.reduce((sum, value) => sum + value, 0) : 0;
  return {
    days,
    total,
    average: total / days.length,
    activeDays: days.filter((value) => value > 0).length,
    best: days[bestIndex]!,
    bestIndex,
    changePct: before && previous > 0 ? Math.round(((total - previous) / previous) * 100) : null,
  };
}

/**
 * Greedy flex-wrap of chips into at most `maxRows` rows of `maxWidth`. When they don't all fit,
 * the last row keeps room for a "+N" chip (`moreWidth(N)` wide) and `hidden` says how many were
 * left out. Returns the shown chips' indexes per row.
 */
export function layoutChips(
  widths: readonly number[],
  maxWidth: number,
  gap: number,
  maxRows: number,
  moreWidth: (hidden: number) => number,
): { rows: number[][]; hidden: number } {
  const rows: number[][] = [];
  let rowWidth = 0;
  let placed = 0;
  for (const [index, width] of widths.entries()) {
    if (rows.length > 0 && rowWidth + gap + width <= maxWidth) {
      rows[rows.length - 1]!.push(index);
      rowWidth += gap + width;
    } else {
      if (rows.length >= maxRows) break;
      rows.push([index]);
      rowWidth = width;
    }
    placed++;
  }
  let hidden = widths.length - placed;
  if (hidden === 0 || rows.length === 0) return { rows, hidden };
  const last = rows[rows.length - 1]!;
  const widthOf = (row: number[]) => row.reduce((sum, index, i) => sum + widths[index]! + (i > 0 ? gap : 0), 0);
  while (last.length > 0 && widthOf(last) + gap + moreWidth(hidden) > maxWidth) {
    last.pop();
    hidden++;
  }
  if (last.length === 0) rows.pop();
  return { rows, hidden };
}

export type ProfileCardOptions = { width?: number; scale?: number };

export async function renderProfileCard(source: ProfileCardData, options: ProfileCardOptions = {}): Promise<Buffer> {
  const result = await composeProfileCard(source, options, { kind: "png" });
  return result.canvas.toBuffer("image/png");
}

/** The /profile card as animation layers. A background's frames fill the banner (and, dimmed, the
 *  container around the panels); `firstFrame` stands in for them while the overlay is drawn. */
export async function renderProfileCardLayers(source: ProfileCardData, options: ProfileCardOptions, firstFrame: ImageRegion): Promise<CardLayers> {
  const result = await composeProfileCard(source, options, { kind: "layers", firstFrame });
  return result.layers!;
}

/** A small Discord-style glyph (rounded controller with two eyes), for the account date. */
function drawDiscordIcon(ctx: SKRSContext2D, x: number, centerY: number, size: number, color: string, eyeColor: string): void {
  const s = size;
  const top = centerY - s * 0.38;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + s * 0.2, top);
  ctx.quadraticCurveTo(x + s * 0.5, top - s * 0.06, x + s * 0.8, top);
  ctx.quadraticCurveTo(x + s * 1.02, top + s * 0.38, x + s * 0.94, top + s * 0.66);
  ctx.quadraticCurveTo(x + s * 0.82, top + s * 0.78, x + s * 0.68, top + s * 0.76);
  ctx.lineTo(x + s * 0.62, top + s * 0.64);
  ctx.quadraticCurveTo(x + s * 0.5, top + s * 0.68, x + s * 0.38, top + s * 0.64);
  ctx.lineTo(x + s * 0.32, top + s * 0.76);
  ctx.quadraticCurveTo(x + s * 0.18, top + s * 0.78, x + s * 0.06, top + s * 0.66);
  ctx.quadraticCurveTo(x - s * 0.02, top + s * 0.38, x + s * 0.2, top);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = eyeColor;
  for (const ex of [0.35, 0.65]) {
    ctx.beginPath();
    ctx.ellipse(x + s * ex, top + s * 0.4, s * 0.085, s * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A small Dreamliner glyph (a plane on an accent disc), for the first-seen date. */
function drawDreamlinerIcon(ctx: SKRSContext2D, x: number, centerY: number, size: number, accent: string): void {
  const r = size / 2;
  const cx = x + r;
  ctx.save();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, centerY, r, 0, Math.PI * 2);
  ctx.fill();
  // A paper plane pointing up and right.
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.55, centerY - r * 0.5);
  ctx.lineTo(cx - r * 0.6, centerY + r * 0.02);
  ctx.lineTo(cx - r * 0.1, centerY + r * 0.12);
  ctx.lineTo(cx + r * 0.0, centerY + r * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** A small padlock glyph, for the Ghost Mode state of the stats card. */
function drawLockIcon(ctx: SKRSContext2D, x: number, centerY: number, size: number, color: string): void {
  const top = centerY - size / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size * 0.12;
  ctx.beginPath();
  ctx.arc(x + size / 2, top + size * 0.4, size * 0.24, Math.PI, 0);
  ctx.lineTo(x + size * 0.74, top + size * 0.5);
  ctx.moveTo(x + size * 0.26, top + size * 0.5);
  ctx.lineTo(x + size * 0.26, top + size * 0.4);
  ctx.stroke();
  roundRect(ctx, x + size * 0.14, top + size * 0.46, size * 0.72, size * 0.5, size * 0.12);
  ctx.fill();
  ctx.restore();
}

/** The dominant colour of part of an image (a sprite-sheet frame, say). */
function regionDominantColor(region: ImageRegion, fallback: string): string {
  const sample = createCanvas(64, Math.max(1, Math.round((64 * region.sh) / Math.max(1, region.sw))));
  sample.getContext("2d").drawImage(region.image, region.sx, region.sy, region.sw, region.sh, 0, 0, sample.width, sample.height);
  return dominantColor(sample, fallback);
}

/**
 * A card-background fill from an image's dominant colour: same hue, saturation capped, at a fixed
 * lightness. Dark enough for white text, and always a clear step lighter than the panels, so they
 * stand out whether the banner is near-black, vivid or pale.
 */
export function backdropFill(dominant: string, lightness = 0.19): string {
  const hex = toHex(dominant);
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return "#24242c";
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => parseInt(part!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : Math.min(0.55, d / (1 - Math.abs(2 * l - 1)));
  const L = lightness;
  const c = (1 - Math.abs(2 * L - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r1, g1, b1].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The card's outer background, built around an image: the image at its natural aspect ratio
 * across the full width, anchored at the top and crisp there, blurring progressively as it goes
 * down and fading into `fill`, which covers the rest. The blur is cheap downscaled copies (with a
 * small filter on the tiny canvas), so it can run per animation frame. `maxHeight` crops a tall
 * source (an avatar) to a band; `subtle` leaves out the crisp layer and softens the rest.
 */
function paintAdaptiveBackdrop(
  ctx: SKRSContext2D,
  source: ImageRegion,
  width: number,
  height: number,
  fill: string,
  options: { maxHeight?: number; subtle?: boolean } = {},
): void {
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, width, height);
  if (!source.sw || !source.sh) return;
  let region = source;
  let bandH = (width * source.sh) / source.sw;
  if (options.maxHeight && bandH > options.maxHeight) {
    const sh = (source.sw * options.maxHeight) / width;
    region = { ...source, sy: source.sy + (source.sh - sh) / 2, sh };
    bandH = options.maxHeight;
  }
  bandH = Math.min(bandH, height);
  const scale = Math.max(1, Math.abs(ctx.getTransform().a) || 1);
  const pxW = Math.max(1, Math.ceil(width * scale));
  const pxH = Math.max(1, Math.ceil(bandH * scale));
  const soft = (factor: number, blur: number): Canvas => {
    const small = createCanvas(Math.max(1, Math.round(pxW / factor)), Math.max(1, Math.round(pxH / factor)));
    const s = small.getContext("2d");
    s.fillStyle = fill;
    s.fillRect(0, 0, small.width, small.height);
    s.filter = `blur(${blur}px)`;
    s.drawImage(region.image, region.sx, region.sy, region.sw, region.sh, 0, 0, small.width, small.height);
    return small;
  };
  // One reusable layer: draw, keep it only where the vertical alpha ramp says, composite.
  const layer = createCanvas(pxW, pxH);
  const lc = layer.getContext("2d");
  lc.imageSmoothingEnabled = true;
  lc.imageSmoothingQuality = "high";
  const band = (image: Image | Canvas, sub: [number, number, number, number] | null, stops: Array<[number, number]>, alpha = 1) => {
    lc.globalCompositeOperation = "source-over";
    lc.clearRect(0, 0, pxW, pxH);
    if (sub) lc.drawImage(image, sub[0], sub[1], sub[2], sub[3], 0, 0, pxW, pxH);
    else lc.drawImage(image, 0, 0, pxW, pxH);
    lc.globalCompositeOperation = "destination-in";
    const ramp = lc.createLinearGradient(0, 0, 0, pxH);
    for (const [at, a] of stops) ramp.addColorStop(at, `rgba(0,0,0,${a})`);
    lc.fillStyle = ramp;
    lc.fillRect(0, 0, pxW, pxH);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer, 0, 0, width, bandH);
    ctx.restore();
  };
  // Overlapping, feathered bands (each ramp eased over many stops): the crisp image hands over
  // to a light blur, which hands over to a heavy one, so no edge shows anywhere.
  const strength = options.subtle ? 0.55 : 1;
  band(soft(32, 4), null, easedRamp(0.7, 1), strength);
  band(soft(10, 2), null, easedRamp(0.3, 0.82), strength);
  if (!options.subtle) band(region.image, [region.sx, region.sy, region.sw, region.sh], easedRamp(0.18, 0.62));
  // A dim keeps the tab labels readable: light over a dark image, stronger over a pale one. Then
  // a long eased fade into the fill, finishing exactly where the image ends.
  const probe = createCanvas(16, 8);
  const pc = probe.getContext("2d");
  pc.drawImage(region.image, region.sx, region.sy, region.sw, region.sh, 0, 0, 16, 8);
  const pixels = pc.getImageData(0, 0, 16, 8).data;
  let luminance = 0;
  for (let i = 0; i < pixels.length; i += 4) luminance += (0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!) / 255;
  luminance /= pixels.length / 4;
  ctx.fillStyle = `rgba(0, 0, 0, ${(0.18 + Math.max(0, luminance - 0.45) * 0.75).toFixed(3)})`;
  ctx.fillRect(0, 0, width, bandH);
  const fade = ctx.createLinearGradient(0, 0, 0, bandH);
  for (const [at, a] of easedRamp(0.2, 1)) fade.addColorStop(at, rgba(fill, 1 - a));
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, width, bandH + 0.5);
}

/** Gradient stops for an alpha that holds at 1 until `from`, then eases (smoothstep) to 0 at `to`. */
export function easedRamp(from: number, to: number, steps = 14): Array<[number, number]> {
  const stops: Array<[number, number]> = [[0, 1]];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const at = from + (to - from) * t;
    stops.push([Math.min(1, Math.max(0, at)), 1 - t * t * (3 - 2 * t)]);
  }
  if (to < 1) stops.push([1, 0]);
  return stops;
}

/** Text drawn with Twemoji, returning its width, without drawing anything visible. */
function measureWithEmoji(text: string, font: string): number {
  return drawTextWithEmoji(createCanvas(1, 1).getContext("2d"), text, 0, 0, font);
}

async function composeProfileCard(
  source: ProfileCardData,
  options: ProfileCardOptions,
  mode: CardMode,
): Promise<{ canvas: Canvas; layers?: CardLayers }> {
  // Characters no font here can draw would show as "No Glyph" boxes: leave them out. (The probe
  // ignores the size in the font string, so any size works.)
  const cosmetics = source.cosmetics ?? {};
  const nameSize = 31; // the largest the display name is drawn; long names step down to fit
  // The name's cosmetic font comes first; anything it can't draw falls back to the site font.
  const nameFont = cosmeticNameFont(cosmetics.nameFont, nameSize, siteFont(750, nameSize));
  const nameGlyphs = cosmeticGlyphSupport(cosmetics.nameFont, nameSize, siteFont(750, nameSize));
  const chipGlyphs = canvasGlyphSupport(siteFont(650, 16));
  const emojiGlyphs = canvasGlyphSupport(`16px "Rank Card Emoji", "Segoe UI Emoji", sans-serif`);
  const username = cleanCanvasName([source.username], chipGlyphs, "user");
  const data: ProfileCardData = {
    ...source,
    displayName: cleanCanvasName([source.displayName, source.username], nameGlyphs, username),
    username,
    badges: source.badges.map((badge) => ({
      ...badge,
      name: stripUnsupportedGlyphs(badge.name, chipGlyphs),
      icon: badge.icon ? stripUnsupportedGlyphs(badge.icon, emojiGlyphs) : badge.icon,
    })),
    progressionIcons: source.progressionIcons.map((icon) => ({
      ...icon,
      name: icon.name ? stripUnsupportedGlyphs(icon.name, chipGlyphs) : icon.name,
      tierName: icon.tierName ? stripUnsupportedGlyphs(icon.tierName, chipGlyphs) : icon.tierName,
    })),
  };
  const width = options.width ?? 760;
  const scale = options.scale ?? 3;
  const now = data.now ?? new Date();
  const accent = toHex(data.accent);
  const hasEmoji = ensureEmojiFont();
  const measure = createCanvas(1, 1).getContext("2d");
  const emojiOk = (emoji: string) => hasTwemoji(emoji) || (hasEmoji && stripUnsupportedGlyphs(emoji, emojiGlyphs) === emoji);

  // Surfaces, darkest to lightest: the container, the profile panel, the cards, chips on them.
  // (As #hex: colorMix returns rgb(), and these get mixed again for tinted chips.) They're
  // re-tinted towards the backdrop image's colour once the images have loaded (below).
  let containerColor = "";
  let panelColor = "";
  let cardColor = "";
  let chipColor = "";
  const tintSurfaces = (tint: string) => {
    // Panels and cards sit a clear step darker than the backdrop fill (backdropFill), so they
    // stand out from it while keeping the image's tint.
    containerColor = toHex(colorMix(tint, 8, SITE.container));
    panelColor = toHex(colorMix(tint, 18, "#0e0e12"));
    cardColor = toHex(colorMix(tint, 18, "#121216"));
    chipColor = toHex(colorMix(tint, 22, SITE.chip));
  };
  tintSurfaces(accent);

  // --- Geometry (card units) ----------------------------------------------------------------
  const pad = 14; // container padding
  const gutter = 16; // between the profile panel and the tab column
  const panel = { x: pad, y: pad, w: Math.round((width - pad * 2 - gutter) * 0.42) };
  const inner = 16; // panel padding
  const contentX = panel.x + inner;
  const contentW = panel.w - inner * 2;
  const bannerH = 124;
  const avatarSize = 88;
  const avatarX = contentX - 2;
  const bannerBottom = panel.y + bannerH;
  const avatarY = bannerBottom - Math.round(avatarSize * 0.56);
  // The display name and @username sit to the right of the avatar, under the banner's edge.
  const nameX = avatarX + avatarSize + 12;
  const nameW = contentX + contentW - nameX;
  const avatarCenter = { x: avatarX + avatarSize / 2, y: avatarY + avatarSize / 2 };
  const right = { x: panel.x + panel.w + gutter, w: 0 };
  right.w = width - pad - right.x;

  // --- Images -------------------------------------------------------------------------------
  const [avatar, banner, stillImage, decoration] = await Promise.all([
    data.avatarURL ? loadImageMaybeDataUri(data.avatarURL).catch(() => null) : Promise.resolve(null),
    data.bannerURL
      ? loadImageMaybeDataUri(data.bannerURL).catch((error: unknown) => {
          log.warn(`[profile card] banner failed to load:`, error);
          return null;
        })
      : Promise.resolve(null),
    mode.kind === "png" && cosmetics.background?.profileStillUrl
      ? loadCosmeticImage(cosmetics.background.profileStillUrl, { large: true }).catch((error: unknown) => {
          log.warn(`[profile card] background still failed to load:`, error);
          return null;
        })
      : Promise.resolve(null),
    // A missing or slow decoration just leaves it off.
    data.avatarDecorationURL
      ? withTimeout("avatar decoration", 4_000, loadImageMaybeDataUri(data.avatarDecorationURL), null)
      : Promise.resolve(null),
  ]);
  const still = stillImage?.width && stillImage.height ? wholeImage(stillImage) : null;

  const icons: Array<{ draw: Image | Canvas; data: ProfileCardData["progressionIcons"][number] }> = [];
  for (const icon of data.progressionIcons) {
    try {
      const image = await loadImageSafe(icon.image);
      icons.push({ draw: icon.tint ? tintedImage(image, icon.tint, Math.ceil(20 * scale)) : image, data: icon });
    } catch {
      // unreadable art: leave that one off
    }
  }
  const oneIcon = icons.find((icon) => icon.data.id === "dreamliner_one") ?? null;

  // --- Left panel layout ----------------------------------------------------------------------
  // The name straddles the banner's bottom edge, like the avatar beside it; @username sits under
  // it on the panel.
  const nameCenterY = bannerBottom - 1;
  const userCenterY = bannerBottom + 27;
  const nameIconSize = 18;
  const emojiFont = `${nameIconSize}px "Rank Card Emoji", "Segoe UI Emoji", sans-serif`;
  const hasNameIcon = Boolean(cosmetics.icon && (cosmetics.icon.imageUrl || (cosmetics.icon.emoji && emojiOk(cosmetics.icon.emoji))));

  const userFont = siteFont(500, 12);
  measure.font = userFont;
  const userText = ellipsize(measure, `@${data.username}`, nameW);
  const userWidth = measure.measureText(userText).width;
  const titleFont = siteFont(650, 12);
  const titlePillPadX = 9;
  const titlePillH = 21;
  const titleTextWidth = cosmetics.title ? Math.min(measureWithEmoji(cosmetics.title.text, titleFont), contentW - titlePillPadX * 2) : 0;
  const titlePillW = cosmetics.title ? titleTextWidth + titlePillPadX * 2 : 0;
  const titleGap = 10;
  // The title pill joins the @username line when it fits, else gets its own line under the avatar.
  const titleInline = Boolean(cosmetics.title) && userWidth + titleGap + titlePillW <= nameW;
  let cursorY = Math.max(avatarY + avatarSize, userCenterY + 9);
  const titleTop = titleInline ? userCenterY - titlePillH / 2 : cursorY + 10;
  if (cosmetics.title && !titleInline) cursorY += 10 + titlePillH;

  // Progression badge art in one strip, like Discord's badge row, with a "+N" overflow chip.
  const stripIcon = 20;
  const stripGap = 6;
  const stripPadX = 8;
  const stripH = 30;
  const moreFont = siteFont(750, 11.5);
  measure.font = moreFont;
  const moreChipWidth = (hidden: number) => measure.measureText(`+${hidden}`).width + 4;
  const strip = layoutChips(
    icons.map(() => stripIcon),
    contentW - stripPadX * 2,
    stripGap,
    1,
    moreChipWidth,
  );
  // The strip sits in a glass pill in the banner's top-left corner, not in the panel body.
  const stripX = panel.x + 10;
  const stripTop = panel.y + 10;

  // Labelled sections, top to bottom.
  const labelFont = siteFont(750, 11);
  const rowFont = siteFont(650, 13.5);
  const rowMutedFont = siteFont(500, 12.5);
  const sectionLabelH = 14;
  const sectionRowH = 20;
  const sectionGap = 16;
  type Section = { label: string; top: number; height: number; draw: (top: number) => Promise<void> | void };
  const sections: Section[] = [];
  const addSection = (label: string, height: number, draw: Section["draw"]) => sections.push({ label, top: 0, height, draw });
  const rowText = (x: number, centerY: number, text: string, muted?: string) => {
    ctx.textBaseline = "middle";
    ctx.font = rowFont;
    ctx.fillStyle = SITE.foreground;
    const shown = ellipsize(ctx, text, contentX + contentW - x);
    ctx.fillText(shown, x, centerY + 0.5);
    let end = x + ctx.measureText(shown).width;
    if (muted) {
      ctx.font = rowMutedFont;
      ctx.fillStyle = SITE.muted;
      const rest = ellipsize(ctx, muted, contentX + contentW - end - 6);
      if (rest) ctx.fillText(rest, end + 6, centerY + 0.5);
      end += 6 + ctx.measureText(rest).width;
    }
    ctx.textBaseline = "alphabetic";
    return end;
  };

  // Like Discord's "Member Since": the Discord account, then when Dreamliner first saw them.
  const created = formatProfileDate(data.accountCreatedAt ?? null);
  const firstSeen = formatProfileDate(data.firstSeenAt ?? null);
  if (created || firstSeen) {
    addSection("Member since", sectionRowH, (top) => {
      const centerY = top + sectionRowH / 2;
      let x = contentX;
      if (created) {
        drawDiscordIcon(ctx, x, centerY, 16, SITE.foreground, panelColor);
        x = rowText(x + 22, centerY, created);
      }
      if (created && firstSeen) {
        ctx.fillStyle = SITE.muted;
        ctx.beginPath();
        ctx.arc(x + 9, centerY, 1.8, 0, Math.PI * 2);
        ctx.fill();
        x += 18;
      }
      if (firstSeen) {
        drawDreamlinerIcon(ctx, x, centerY, 16, accent);
        rowText(x + 22, centerY, firstSeen);
      }
    });
  }
  const seen = lastSeenLabel(data.lastActiveAt, now);
  if (seen) {
    addSection("Last seen", sectionRowH, (top) => {
      const centerY = top + sectionRowH / 2;
      ctx.fillStyle = seen.active ? SITE.online : SITE.muted;
      ctx.beginPath();
      ctx.arc(contentX + 7.5, centerY, 4.5, 0, Math.PI * 2);
      ctx.fill();
      rowText(contentX + 23, centerY, seen.active ? "Active now" : formatAgo(Math.max(0, now.getTime() - data.lastActiveAt!.getTime())));
    });
  }
  const oneSince = formatProfileDate(data.oneSince ?? null);
  if (oneSince) {
    addSection("Dreamliner One", sectionRowH, (top) => {
      const centerY = top + sectionRowH / 2;
      if (oneIcon) ctx.drawImage(oneIcon.draw, contentX, centerY - 8, 16, 16);
      rowText(contentX + (oneIcon ? 23 : 0), centerY, `Since ${oneSince}`);
    });
  }

  // Profile badges as chips (Discord's role chips): icon or colour dot, then the name.
  const chipFont = siteFont(650, 12);
  const chipH = 25;
  const chipPadX = 9;
  const chipIcon = 15;
  const chipInnerGap = 6;
  const chipGap = 6;
  measure.font = chipFont;
  const chips = data.badges.map((badge) => {
    const showImage = Boolean(badge.iconImageUrl);
    const showEmoji = !showImage && Boolean(badge.icon && emojiOk(badge.icon));
    const textMax = contentW - chipPadX * 2 - chipIcon - chipInnerGap;
    const text = ellipsize(measure, badge.name, textMax);
    const w = chipPadX * 2 + chipIcon + chipInnerGap + measure.measureText(text).width;
    return { badge, text, showImage, showEmoji, w };
  });
  measure.font = chipFont;
  const moreBadgeWidth = (hidden: number) => measure.measureText(`+${hidden}`).width + chipPadX * 2;
  const badgeLayout = layoutChips(
    chips.map((chip) => chip.w),
    contentW,
    chipGap,
    3,
    moreBadgeWidth,
  );
  if (chips.length > 0) {
    const rowsCount = Math.max(1, badgeLayout.rows.length);
    addSection("Badges", rowsCount * chipH + (rowsCount - 1) * chipGap, async (top) => {
      let rowTop = top;
      const rowsToDraw = badgeLayout.rows.length > 0 ? badgeLayout.rows : [[]];
      for (const [rowIndex, row] of rowsToDraw.entries()) {
        let chipX = contentX;
        for (const index of row) {
          const chip = chips[index]!;
          const color = chip.badge.colorHex ? toHex(chip.badge.colorHex) : accent;
          const validColor = /^#[0-9a-f]{6}$/i.test(color) ? color : accent;
          ctx.fillStyle = colorMix(validColor, 12, chipColor);
          roundRect(ctx, chipX, rowTop, chip.w, chipH, 999);
          ctx.fill();
          const centerY = rowTop + chipH / 2;
          let cursor = chipX + chipPadX;
          let drewIcon = false;
          if (chip.showImage) {
            try {
              const icon = await loadImageMaybeDataUri(chip.badge.iconImageUrl!);
              ctx.save();
              ctx.beginPath();
              ctx.arc(cursor + chipIcon / 2, centerY, chipIcon / 2, 0, Math.PI * 2);
              ctx.clip();
              const cover = Math.max(chipIcon / icon.width, chipIcon / icon.height);
              ctx.drawImage(icon, cursor + (chipIcon - icon.width * cover) / 2, centerY - (icon.height * cover) / 2, icon.width * cover, icon.height * cover);
              ctx.restore();
              drewIcon = true;
            } catch {
              // falls back to the colour dot
            }
          } else if (chip.showEmoji) {
            ctx.fillStyle = SITE.foreground;
            ctx.textBaseline = "middle";
            drawTextWithEmoji(ctx, chip.badge.icon, cursor, centerY + 0.5, `${chipIcon * 0.87}px "Rank Card Emoji", "Segoe UI Emoji", sans-serif`);
            ctx.textBaseline = "alphabetic";
            drewIcon = true;
          }
          if (!drewIcon) {
            ctx.fillStyle = validColor;
            ctx.beginPath();
            ctx.arc(cursor + chipIcon / 2, centerY, 5, 0, Math.PI * 2);
            ctx.fill();
          }
          cursor += chipIcon + chipInnerGap;
          ctx.fillStyle = SITE.foreground;
          ctx.font = chipFont;
          ctx.textBaseline = "middle";
          ctx.fillText(chip.text, cursor, centerY + 0.5);
          ctx.textBaseline = "alphabetic";
          chipX += chip.w + chipGap;
        }
        if (badgeLayout.hidden > 0 && rowIndex === rowsToDraw.length - 1) {
          const w = moreBadgeWidth(badgeLayout.hidden);
          ctx.fillStyle = chipColor;
          roundRect(ctx, chipX, rowTop, w, chipH, 999);
          ctx.fill();
          ctx.fillStyle = SITE.muted;
          ctx.font = chipFont;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(`+${badgeLayout.hidden}`, chipX + w / 2, rowTop + chipH / 2 + 0.5);
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
        }
        rowTop += chipH + chipGap;
      }
    });
  }

  cursorY += sections.length > 0 ? 18 : 0;
  for (const section of sections) {
    section.top = cursorY;
    cursorY += sectionLabelH + 7 + section.height + sectionGap;
  }
  const leftBottom = cursorY - (sections.length > 0 ? sectionGap : 0) + inner;

  // --- Right column layout: faux tab bar, then stacked cards ------------------------------------
  const tabsTop = pad + 2;
  const tabsH = 32;
  const cardsTop = tabsTop + tabsH + 14;
  const cardGap = 10;
  const cardPad = 15;
  const cardHeaderH = 54;
  type RightCard = { height: number; title: string; subtitle: string; draw: (top: number) => void };
  const cards: RightCard[] = [];
  const stats = data.stats ?? null;
  const count = (value: number) => value.toLocaleString("en-US");
  const cardContentW = right.w - cardPad * 2;

  /** A row of value-over-label stats. Columns are as wide as their content with the spare room
   *  shared out as even gaps; values shrink (then truncate) only if the row can't fit. */
  const drawTiles = (tiles: Array<{ value: string; label: string }>, x: number, top: number, w: number, maxSize: number, labelSize: number) => {
    const minGap = 14;
    let size = maxSize;
    const widthsAt = (px: number) =>
      tiles.map((tile) => {
        ctx.font = siteFont(750, px);
        const value = ctx.measureText(tile.value).width;
        ctx.font = siteFont(650, labelSize);
        return Math.max(value, ctx.measureText(tile.label).width);
      });
    let widths = widthsAt(size);
    const fits = (list: number[]) => list.reduce((sum, width) => sum + width, 0) + minGap * (list.length - 1) <= w;
    while (size > 12 && !fits(widths)) widths = widthsAt(--size);
    const colMax = (w - minGap * (tiles.length - 1)) / tiles.length;
    if (!fits(widths)) widths = widths.map((width) => Math.min(width, colMax));
    const gap = tiles.length > 1 ? (w - widths.reduce((sum, width) => sum + width, 0)) / (tiles.length - 1) : 0;
    const valueY = top + size / 2 + 1;
    const labelY = top + size + labelSize / 2 + 6;
    let cursor = x;
    for (const [index, tile] of tiles.entries()) {
      const colW = widths[index]!;
      ctx.textBaseline = "middle";
      ctx.font = siteFont(750, size);
      ctx.fillStyle = SITE.foreground;
      ctx.fillText(ellipsize(ctx, tile.value, colW), cursor, valueY);
      ctx.font = siteFont(650, labelSize);
      ctx.fillStyle = SITE.muted;
      ctx.fillText(ellipsize(ctx, tile.label, colW), cursor, labelY);
      ctx.textBaseline = "alphabetic";
      cursor += colW + gap;
    }
  };

  if (stats?.hidden) {
    cards.push({
      height: cardHeaderH + 22 + cardPad,
      title: "Stats",
      subtitle: "Ghost Mode is on",
      draw: (top) => {
        const centerY = top + cardHeaderH + 11;
        drawLockIcon(ctx, right.x + cardPad, centerY, 15, SITE.muted);
        ctx.font = siteFont(500, 12.5);
        ctx.fillStyle = SITE.muted;
        ctx.textBaseline = "middle";
        ctx.fillText(ellipsize(ctx, "Their activity across servers is private.", cardContentW - 23), right.x + cardPad + 23, centerY + 0.5);
        ctx.textBaseline = "alphabetic";
      },
    });
  } else if (stats) {
    const tiles: Array<{ value: string; label: string }> = [
      { value: count(stats.totalMessages), label: stats.totalMessages === 1 ? "Message" : "Messages" },
      { value: count(stats.serverCount), label: stats.serverCount === 1 ? "Server" : "Servers" },
      { value: stats.globalRank ? `#${count(stats.globalRank)}` : "Unranked", label: "Global rank" },
    ];
    if (stats.streak != null) tiles.push({ value: count(stats.streak), label: stats.streak === 1 ? "Day streak" : "Day streak" });
    const tileH = 44;
    cards.push({
      height: cardHeaderH + tileH + cardPad - 2,
      title: "Stats",
      subtitle: stats.asOf ? `Across every server, ${snapshotAgeLabel(stats.asOf, now)}` : "Across every server",
      draw: (top) => drawTiles(tiles, right.x + cardPad, top + cardHeaderH, cardContentW, 21, 11.5),
    });

    const activityStats = summarizeActivity(stats.daily ?? [], ACTIVITY_DAYS);
    if (activityStats) {
      const days = activityStats.days;
      const voiceMinutes = (stats.voiceDaily ?? []).slice(-ACTIVITY_DAYS).reduce((sum, value) => sum + value, 0);
      const hours = stats.hours?.length === 24 && stats.hours.some((value) => value > 0) ? stats.hours : null;
      const tilesH = 36;
      const chartHead = 14; // room above the bars for the best day's label
      const barsH = 58;
      const axisH = 16;
      const hoursBlockH = hours ? 14 + 6 + 15 + 14 : 0;
      const tiles: Array<{ value: string; label: string }> = [
        { value: count(activityStats.total), label: activityStats.total === 1 ? "Message" : "Messages" },
        { value: activityStats.average < 10 ? activityStats.average.toFixed(1) : count(Math.round(activityStats.average)), label: "Daily average" },
        { value: `${activityStats.activeDays}/${days.length}`, label: "Active days" },
        voiceMinutes > 0
          ? { value: formatVoiceMinutes(voiceMinutes), label: "In voice" }
          : { value: count(activityStats.best), label: "Best day" },
      ];
      cards.push({
        height: cardHeaderH + tilesH + 14 + chartHead + barsH + axisH + (hours ? 12 + hoursBlockH : 0) + cardPad - 4,
        title: "Activity",
        subtitle: `Last ${days.length} days across every server`,
        draw: (top) => {
          const x0 = right.x + cardPad;
          const rightEdge = x0 + cardContentW;

          // Trend against the period before, as a pill on the title line.
          if (activityStats.changePct !== null) {
            const pct = activityStats.changePct;
            const text = pct === 0 ? `Same as the previous ${days.length} days` : `${pct > 0 ? "+" : "-"}${Math.abs(pct)}% vs previous ${days.length} days`;
            ctx.font = siteFont(650, 11);
            const w = ctx.measureText(text).width + 18;
            const pillH = 20;
            const tone = pct > 0 ? SITE.online : SITE.muted;
            ctx.fillStyle = colorMix(tone, 18, cardColor);
            roundRect(ctx, rightEdge - w, top + 23 - pillH / 2, w, pillH, 999);
            ctx.fill();
            ctx.fillStyle = pct > 0 ? colorMix(SITE.online, 75, "#ffffff") : SITE.foreground;
            ctx.textBaseline = "middle";
            ctx.fillText(text, rightEdge - w + 9, top + 23.5);
            ctx.textBaseline = "alphabetic";
          }

          let y = top + cardHeaderH;
          drawTiles(tiles, x0, y, cardContentW, 17, 11);
          y += tilesH + 14;

          // Daily bars, the best day labelled.
          const barsTop = y + chartHead;
          const max = Math.max(1, activityStats.best);
          const gap = 3;
          const barW = (cardContentW - gap * (days.length - 1)) / days.length;
          ctx.fillStyle = "rgba(255,255,255,0.05)";
          ctx.fillRect(x0, barsTop, cardContentW, 1);
          ctx.fillRect(x0, barsTop + barsH / 2, cardContentW, 1);
          const strong = colorMix(accent, 72, "#ffffff");
          for (const [index, value] of days.entries()) {
            const bx = x0 + index * (barW + gap);
            if (value <= 0) {
              ctx.fillStyle = chipColor;
              roundRect(ctx, bx, barsTop + barsH - 3, barW, 3, 1.5);
              ctx.fill();
              continue;
            }
            const h = Math.max(4, (value / max) * barsH);
            const isBest = index === activityStats.bestIndex;
            const gradient = ctx.createLinearGradient(0, barsTop + barsH - h, 0, barsTop + barsH);
            gradient.addColorStop(0, isBest ? strong : rgba(accent, 0.85));
            gradient.addColorStop(1, isBest ? accent : rgba(accent, 0.35));
            ctx.fillStyle = gradient;
            roundRect(ctx, bx, barsTop + barsH - h, barW, h, Math.min(3, barW / 2));
            ctx.fill();
          }
          if (activityStats.best > 0) {
            const bx = x0 + activityStats.bestIndex * (barW + gap) + barW / 2;
            const h = barsH;
            ctx.font = siteFont(750, 10.5);
            ctx.fillStyle = SITE.foreground;
            ctx.textBaseline = "middle";
            const label = count(activityStats.best);
            const lw = ctx.measureText(label).width;
            ctx.fillText(label, Math.min(rightEdge - lw, Math.max(x0, bx - lw / 2)), barsTop + barsH - h - 8);
            ctx.textBaseline = "alphabetic";
          }

          // Dates under the bars.
          const endDate = new Date(now.getTime() - (stats.asOf ? 86_400_000 : 0));
          const dayLabel = (index: number) => {
            const date = new Date(endDate.getTime() - (days.length - 1 - index) * 86_400_000);
            return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
          };
          const axisY = barsTop + barsH + 10;
          ctx.font = siteFont(500, 10.5);
          ctx.fillStyle = SITE.muted;
          ctx.textBaseline = "middle";
          ctx.fillText(dayLabel(0), x0, axisY);
          ctx.textAlign = "center";
          ctx.fillText(dayLabel(Math.floor(days.length / 2)), x0 + Math.floor(days.length / 2) * (barW + gap) + barW / 2, axisY);
          ctx.textAlign = "right";
          ctx.fillText(stats.asOf ? "Yesterday" : "Today", rightEdge, axisY);
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";

          // Active hours: a 24-cell heat strip (UTC).
          if (hours) {
            let hy = barsTop + barsH + axisH + 12;
            const peak = hours.indexOf(Math.max(...hours));
            ctx.textBaseline = "middle";
            ctx.font = siteFont(750, 10.5);
            ctx.fillStyle = SITE.muted;
            ctx.fillText("ACTIVE HOURS (UTC)", x0, hy + 7);
            ctx.textAlign = "right";
            ctx.font = siteFont(650, 11);
            ctx.fillStyle = SITE.foreground;
            ctx.fillText(`Busiest around ${String(peak).padStart(2, "0")}:00`, rightEdge, hy + 7);
            ctx.textAlign = "left";
            hy += 14 + 6;
            const hourMax = Math.max(1, ...hours);
            const cellGap = 3;
            const cellW = (cardContentW - cellGap * 23) / 24;
            for (const [hour, value] of hours.entries()) {
              const share = value / hourMax;
              ctx.fillStyle = value > 0 ? colorMix(accent, Math.round(18 + share * 82), chipColor) : chipColor;
              roundRect(ctx, x0 + hour * (cellW + cellGap), hy, cellW, 15, 3);
              ctx.fill();
            }
            hy += 15 + 8;
            ctx.font = siteFont(500, 10);
            ctx.fillStyle = SITE.muted;
            for (const hour of [0, 6, 12, 18]) {
              ctx.fillText(String(hour).padStart(2, "0"), x0 + hour * (cellW + cellGap), hy);
            }
            ctx.textAlign = "right";
            ctx.fillText("23", rightEdge, hy);
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
          }
        },
      });
    }
  }

  // Highlights: progression badges by name and tier.
  const named = icons.filter((icon) => icon.data.name);
  if (named.length > 0) {
    // One row of up to three tiles; past that the third becomes "+N more".
    const maxTiles = 3;
    const shown = named.length > maxTiles ? named.slice(0, maxTiles - 1) : named;
    const extra = named.length - shown.length;
    const tileCount = shown.length + (extra > 0 ? 1 : 0);
    const tileH = 46;
    const tileGap = 8;
    cards.push({
      height: cardHeaderH + tileH + cardPad - 2,
      title: "Highlights",
      subtitle: named.length === 1 ? "1 progression badge" : `${named.length} progression badges`,
      draw: (top) => {
        // The "+N" tile is only as wide as its text; the badge tiles share the rest.
        ctx.font = siteFont(650, 12.5);
        const moreW = extra > 0 ? ctx.measureText(`+${extra}`).width + 28 : 0;
        const colW = (cardContentW - (extra > 0 ? moreW + tileGap : 0) - tileGap * (shown.length - 1)) / shown.length;
        for (let index = 0; index < tileCount; index++) {
          const x = right.x + cardPad + index * (colW + tileGap);
          const y = top + cardHeaderH;
          const w = index >= shown.length ? moreW : colW;
          ctx.fillStyle = chipColor;
          roundRect(ctx, x, y, w, tileH, 10);
          ctx.fill();
          const centerY = y + tileH / 2;
          if (index >= shown.length) {
            ctx.font = siteFont(650, 12.5);
            ctx.fillStyle = SITE.muted;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(`+${extra}`, x + w / 2, centerY + 0.5);
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            continue;
          }
          const icon = shown[index]!;
          const art = 28;
          ctx.drawImage(icon.draw, x + 10, centerY - art / 2, art, art);
          const textX = x + 10 + art + 10;
          const textW = colW - (textX - x) - 10;
          const since = formatProfileDate(icon.data.since ?? null);
          const sub = icon.data.tierName ?? (since ? `Since ${since}` : null);
          ctx.textBaseline = "middle";
          ctx.font = siteFont(650, 12.5);
          ctx.fillStyle = SITE.foreground;
          ctx.fillText(ellipsize(ctx, icon.data.name!, textW), textX, sub ? centerY - 7 : centerY + 0.5);
          if (sub) {
            ctx.font = siteFont(500, 11);
            ctx.fillStyle = SITE.muted;
            ctx.fillText(ellipsize(ctx, sub, textW), textX, centerY + 9);
          }
          ctx.textBaseline = "alphabetic";
        }
      },
    });
  }

  if (cards.length === 0) {
    cards.push({ height: cardHeaderH + 6, title: "Overview", subtitle: "Nothing to show here yet", draw: () => undefined });
  }
  const rightBottom = cards.reduce((y, card) => y + card.height + cardGap, cardsTop) - cardGap + pad;

  // The profile panel runs off the bottom edge: the container's rounded clip hides its bottom
  // corners, like Discord's popout.
  const height = Math.round(Math.max(leftBottom, rightBottom, 380));
  const panelH = height - panel.y + 24;
  const bannerRect = { x: panel.x, y: panel.y, w: panel.w, h: bannerH };

  const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
  const scaled = (target: Canvas) => {
    const c = target.getContext("2d");
    c.scale(scale, scale);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    return c;
  };

  // The card's outer background is built around an image (paintAdaptiveBackdrop): an equipped
  // (bought) background first, which overtakes the Discord banner here and in the banner area,
  // painted per animation frame; else the banner; else a soft avatar band. The fill and the
  // surfaces' tint come from whichever image is shown.
  const backdropSource = mode.kind === "layers" ? mode.firstFrame : still;
  const tintSource = backdropSource ?? (banner ? wholeImage(banner) : avatar ? wholeImage(avatar) : null);
  const imageTint = tintSource ? toHex(regionDominantColor(tintSource, accent)) : accent;
  const outerFill = backdropFill(imageTint);
  // Surfaces take the hue at a fixed mid lightness, so a pale image can't lift them into the fill.
  tintSurfaces(backdropFill(imageTint, 0.45));
  // Banner or avatar (no equipped background): static, so painted once and reused.
  let staticOuter: Canvas | null = null;
  if (!backdropSource) {
    staticOuter = createCanvas(Math.round(width * scale), Math.round(height * scale));
    const c = staticOuter.getContext("2d");
    c.scale(scale, scale);
    if (banner) paintAdaptiveBackdrop(c, wholeImage(banner), width, height, outerFill);
    else if (avatar) paintAdaptiveBackdrop(c, wholeImage(avatar), width, height, outerFill, { maxHeight: 240, subtle: true });
    else {
      c.fillStyle = outerFill;
      c.fillRect(0, 0, width, height);
    }
  }
  // Glass: panels show a heavily blurred copy of the outer background through a translucent
  // tinted fill. The copy is made at 1/8 size (cheap, and soft anyway) and cached per source:
  // once for a static backdrop, once per frame for an animated one.
  const blurCache = new Map<ImageRegion | null, Canvas>();
  const blurredOuter = (background: ImageRegion | null): Canvas => {
    const key = staticOuter ? null : background;
    const hit = blurCache.get(key);
    if (hit) return hit;
    const f = scale / 8;
    const base = createCanvas(Math.max(1, Math.round(width * f)), Math.max(1, Math.round(height * f)));
    const b = base.getContext("2d");
    b.scale(f, f);
    b.fillStyle = containerColor;
    b.fillRect(0, 0, width, height);
    if (staticOuter) b.drawImage(staticOuter, 0, 0, width, height);
    else if (background) paintAdaptiveBackdrop(b, background, width, height, outerFill);
    const blurred = createCanvas(base.width, base.height);
    const bc = blurred.getContext("2d");
    bc.filter = `blur(${Math.max(2, 24 * f)}px)`;
    bc.drawImage(base, 0, 0);
    blurCache.set(key, blurred);
    return blurred;
  };
  /** A glass surface: the blurred backdrop through a translucent, tinted dark fill. */
  const glass = (target: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, color: string, blurred: Canvas, alpha: number) => {
    target.save();
    roundRect(target, x, y, w, h, r);
    target.clip();
    target.drawImage(blurred, 0, 0, width, height);
    target.fillStyle = rgba(color, alpha);
    target.fillRect(x, y, w, h);
    target.restore();
  };

  const dotActive = Boolean(seen?.active);
  const dotCenter = { x: avatarX + avatarSize * 0.854, y: avatarY + avatarSize * 0.854 };

  // The panel's banner area without a banner or background: the avatar, softly blurred.
  const avatarSoft = (() => {
    if (!avatar) return null;
    const small = createCanvas(Math.max(1, Math.round(width / 4)), Math.max(1, Math.round(bannerH / 4)));
    const s = small.getContext("2d");
    s.filter = "blur(6px) saturate(1.15)";
    const cover = Math.max(small.width / avatar.width, small.height / avatar.height) * 1.3;
    s.drawImage(avatar, (small.width - avatar.width * cover) / 2, (small.height - avatar.height * cover) / 2, avatar.width * cover, avatar.height * cover);
    return small;
  })();

  // --- Backdrop: container, profile panel and its banner (per frame when animated) -------------
  const paintBackdrop = (target: SKRSContext2D, background: ImageRegion | null): boolean => {
    const full = { x: 0, y: 0, w: width, h: height };
    target.save();
    roundRect(target, 0, 0, width, height, 18);
    target.clip();
    target.fillStyle = containerColor;
    target.fillRect(0, 0, width, height);
    if (staticOuter) target.drawImage(staticOuter, 0, 0, width, height);
    else if (background) paintAdaptiveBackdrop(target, background, width, height, outerFill);
    if (cosmetics.glow) drawGlow(target, cosmetics.glow, full, avatarCenter);

    // The profile panel: glass, a glow echo, and its banner.
    const pc = target;
    glass(pc, panel.x, panel.y, panel.w, panelH, 14, panelColor, blurredOuter(background), 0.88);

    pc.save();
    roundRect(pc, panel.x, panel.y, panel.w, panelH, 14);
    pc.clip();
    if (cosmetics.glow) {
      // A softer echo of the glow on the panel itself.
      pc.save();
      pc.globalAlpha = 0.3;
      drawGlow(pc, cosmetics.glow, { x: panel.x, y: panel.y, w: panel.w, h: panelH }, avatarCenter);
      pc.restore();
    }
    pc.beginPath();
    pc.rect(bannerRect.x, bannerRect.y, bannerRect.w, bannerRect.h);
    pc.clip();
    const bannerFill = pc.createLinearGradient(bannerRect.x, bannerRect.y, bannerRect.x + bannerRect.w, bannerRect.y + bannerRect.h);
    bannerFill.addColorStop(0, colorMix(accent, 70, "#000000"));
    bannerFill.addColorStop(1, colorMix(accent, 40, "#000000"));
    pc.fillStyle = bannerFill;
    pc.fillRect(bannerRect.x, bannerRect.y, bannerRect.w, bannerRect.h);
    // The banner area: an equipped background first, then the Discord banner, then the avatar
    // softly blurred.
    if (background) {
      drawCoverRegion(pc, background, bannerRect);
    } else if (banner) {
      const cover = Math.max(bannerRect.w / banner.width, bannerRect.h / banner.height);
      const w = banner.width * cover;
      const h = banner.height * cover;
      pc.drawImage(banner, bannerRect.x + (bannerRect.w - w) / 2, bannerRect.y + (bannerRect.h - h) / 2, w, h);
    } else if (avatarSoft) {
      pc.drawImage(avatarSoft, bannerRect.x, bannerRect.y, bannerRect.w, bannerRect.h);
      pc.fillStyle = "rgba(0, 0, 0, 0.2)";
      pc.fillRect(bannerRect.x, bannerRect.y, bannerRect.w, bannerRect.h);
    }
    pc.restore();
    target.restore();
    return Boolean(background);
  };

  // Animated: the backdrop is painted per frame, everything else goes on a transparent overlay.
  const backdropCanvas = mode.kind === "layers" ? createCanvas(canvas.width, canvas.height) : canvas;
  paintBackdrop(scaled(backdropCanvas), mode.kind === "layers" ? mode.firstFrame : still);
  const ctx = mode.kind === "layers" ? scaled(canvas) : canvas.getContext("2d");

  // The badge pill's glass: a blurred copy of the backdrop as painted (banner area included),
  // taken before anything is drawn over it. Quarter size; it's only seen blurred.
  const bannerGlass = (() => {
    if (icons.length === 0) return null;
    const small = createCanvas(Math.max(1, Math.round(backdropCanvas.width / 4)), Math.max(1, Math.round(backdropCanvas.height / 4)));
    const s = small.getContext("2d");
    s.filter = `blur(${Math.max(2, 2.5 * scale)}px)`;
    s.drawImage(backdropCanvas, 0, 0, small.width, small.height);
    return small;
  })();

  // --- Avatar: straight over the banner and panel, lifted by a soft drop shadow ----------------
  // The avatar and its frame cosmetic go on their own layer so the shadow follows their combined
  // shape.
  const avatarBox = avatarSize * 1.5;
  const avatarOrigin = { x: avatarCenter.x - avatarBox / 2, y: avatarCenter.y - avatarBox / 2 };
  const avatarLayer = createCanvas(Math.ceil(avatarBox * scale), Math.ceil(avatarBox * scale));
  const ac = avatarLayer.getContext("2d");
  ac.setTransform(scale, 0, 0, scale, -avatarOrigin.x * scale, -avatarOrigin.y * scale);
  ac.imageSmoothingEnabled = true;
  ac.imageSmoothingQuality = "high";
  ac.save();
  ac.beginPath();
  ac.arc(avatarCenter.x, avatarCenter.y, avatarSize / 2, 0, Math.PI * 2);
  ac.clip();
  ac.fillStyle = SITE.chip;
  ac.fillRect(avatarX, avatarY, avatarSize, avatarSize);
  if (avatar) {
    const cover = Math.max(avatarSize / avatar.width, avatarSize / avatar.height);
    const w = avatar.width * cover;
    const h = avatar.height * cover;
    ac.drawImage(avatar, avatarX + (avatarSize - w) / 2, avatarY + (avatarSize - h) / 2, w, h);
  } else {
    ac.fillStyle = SITE.muted;
    ac.font = siteFont(750, 34);
    ac.textAlign = "center";
    ac.textBaseline = "middle";
    ac.fillText((firstGrapheme(data.displayName) ?? "?").toUpperCase(), avatarCenter.x, avatarCenter.y + 1);
  }
  ac.restore();
  if (cosmetics.frame) {
    await drawAvatarFrame(ac, cosmetics.frame, { x: avatarX, y: avatarY, size: avatarSize, radius: avatarSize / 2 }, data.username).catch(
      (error: unknown) => log.warn(`[profile card] avatar frame failed to draw:`, error),
    );
  }
  // Canvas shadows are in device pixels, so they're scaled with the card.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 18 * scale;
  ctx.shadowOffsetY = 6 * scale;
  ctx.drawImage(avatarLayer, avatarOrigin.x, avatarOrigin.y, avatarLayer.width / scale, avatarLayer.height / scale);
  ctx.restore();
  // The Discord avatar decoration: over the avatar and any frame cosmetic, after (and outside) the
  // drop shadow, at Discord's 1.2x of the avatar. On the static overlay when animated.
  if (decoration?.width && decoration.height) {
    const size = avatarSize * 1.2;
    const fit = Math.min(size / decoration.width, size / decoration.height);
    const w = decoration.width * fit;
    const h = decoration.height * fit;
    ctx.drawImage(decoration, avatarCenter.x - w / 2, avatarCenter.y - h / 2, w, h);
  }
  if (dotActive) {
    // A border in the panel colour and a small shadow keep the dot readable on any avatar.
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur = 4 * scale;
    ctx.shadowOffsetY = 1 * scale;
    ctx.fillStyle = panelColor;
    ctx.beginPath();
    ctx.arc(dotCenter.x, dotCenter.y, 10.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = SITE.online;
    ctx.beginPath();
    ctx.arc(dotCenter.x, dotCenter.y, 7.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Name, @username and title ----------------------------------------------------------------
  // Big, stepping down (to 20) for a long name before it's truncated.
  const nameRoom = Math.max(40, nameW - (hasNameIcon ? nameIconSize + 6 : 0));
  let nameFitSize = nameSize;
  let fittedFont = nameFont;
  ctx.font = fittedFont;
  while (nameFitSize > 20 && ctx.measureText(data.displayName).width > nameRoom) {
    nameFitSize -= 1;
    fittedFont = cosmeticNameFont(cosmetics.nameFont, nameFitSize, siteFont(750, nameFitSize));
    ctx.font = fittedFont;
  }
  const name = ellipsize(ctx, data.displayName, nameRoom);
  ctx.textBaseline = "middle";
  const nameEnd =
    nameX +
    drawCosmeticName(ctx, name, nameX, nameCenterY + 0.5, { font: fittedFont, color: cosmetics.nameColor, defaultColor: "#ffffff", sizePx: nameFitSize, shadow: true });
  ctx.textBaseline = "alphabetic";
  if (hasNameIcon && cosmetics.icon) {
    await drawNameIcon(ctx, cosmetics.icon, nameEnd + 6, nameCenterY, nameIconSize, { emojiFont, canDrawEmoji: emojiOk }).catch(() => 0);
  }

  ctx.font = userFont;
  ctx.fillStyle = SITE.muted;
  ctx.textBaseline = "middle";
  ctx.fillText(userText, nameX, userCenterY + 0.5);
  ctx.textBaseline = "alphabetic";
  if (cosmetics.title) {
    const pillX = titleInline ? nameX + userWidth + titleGap : contentX;
    const titleColor = cosmetics.title.color ? toHex(cosmetics.title.color) : null;
    ctx.fillStyle = titleColor && /^#[0-9a-f]{6}$/i.test(titleColor) ? colorMix(titleColor, 16, chipColor) : chipColor;
    roundRect(ctx, pillX, titleTop, titlePillW, titlePillH, 999);
    ctx.fill();
    ctx.textBaseline = "middle";
    drawCosmeticTitle(ctx, cosmetics.title, pillX + titlePillPadX, titleTop + titlePillH / 2 + 0.5, titleFont, "rgba(255,255,255,0.85)", titleTextWidth + 1);
    ctx.textBaseline = "alphabetic";
  }

  // --- Badge strip ------------------------------------------------------------------------------
  if (icons.length > 0) {
    const shownIcons = strip.rows[0] ?? [];
    const iconsW = shownIcons.length * stripIcon + Math.max(0, shownIcons.length - 1) * stripGap;
    const moreW = strip.hidden > 0 ? (shownIcons.length > 0 ? stripGap : 0) + moreChipWidth(strip.hidden) : 0;
    const stripW = stripPadX * 2 + iconsW + moreW;
    // Glass: the blurred banner through a translucent dark fill. No border or shine.
    ctx.save();
    roundRect(ctx, stripX, stripTop, stripW, stripH, 999);
    ctx.clip();
    if (bannerGlass) ctx.drawImage(bannerGlass, 0, 0, width, height);
    ctx.fillStyle = "rgba(10, 10, 14, 0.45)";
    ctx.fillRect(stripX, stripTop, stripW, stripH);
    ctx.restore();
    let iconX = stripX + stripPadX;
    const centerY = stripTop + stripH / 2;
    for (const index of shownIcons) {
      ctx.drawImage(icons[index]!.draw, iconX, centerY - stripIcon / 2, stripIcon, stripIcon);
      iconX += stripIcon + stripGap;
    }
    if (strip.hidden > 0) {
      ctx.font = moreFont;
      ctx.fillStyle = SITE.foreground;
      ctx.textBaseline = "middle";
      ctx.fillText(`+${strip.hidden}`, shownIcons.length > 0 ? iconX : stripX + stripPadX, centerY + 0.5);
      ctx.textBaseline = "alphabetic";
    }
  }

  // --- Sections ---------------------------------------------------------------------------------
  for (const section of sections) {
    ctx.font = labelFont;
    ctx.fillStyle = SITE.muted;
    ctx.textBaseline = "middle";
    ctx.fillText(section.label.toUpperCase(), contentX, section.top + sectionLabelH / 2);
    ctx.textBaseline = "alphabetic";
    await section.draw(section.top + sectionLabelH + 7);
  }

  // --- Tab bar: a visual echo of the profile page's tabs ----------------------------------------
  const tabs = ["Overview", "Activity", "Cards", "Servers"];
  let tabX = right.x;
  ctx.font = siteFont(650, 14);
  ctx.textBaseline = "middle";
  for (const [index, tab] of tabs.entries()) {
    const tabW = ctx.measureText(tab).width;
    ctx.fillStyle = index === 0 ? SITE.foreground : SITE.muted;
    ctx.fillText(tab, tabX, tabsTop + 12);
    if (index === 0) {
      ctx.fillStyle = accent;
      roundRect(ctx, tabX, tabsTop + tabsH - 3, tabW, 3, 1.5);
      ctx.fill();
    }
    tabX += tabW + 24;
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(right.x, tabsTop + tabsH, right.w, 1);

  // --- Cards ------------------------------------------------------------------------------------
  let cardTop = cardsTop;
  for (const card of cards) {
    // On the static overlay: over an animated background the glass shows the first frame's blur.
    glass(ctx, right.x, cardTop, right.w, card.height, 13, cardColor, blurredOuter(backdropSource), 0.86);
    ctx.textBaseline = "middle";
    ctx.font = siteFont(750, 14.5);
    ctx.fillStyle = SITE.foreground;
    ctx.fillText(card.title, right.x + cardPad, cardTop + 23);
    ctx.font = siteFont(500, 11.5);
    ctx.fillStyle = SITE.muted;
    ctx.fillText(ellipsize(ctx, card.subtitle, cardContentW - 90), right.x + cardPad, cardTop + 41);
    ctx.textBaseline = "alphabetic";
    card.draw(cardTop);
    cardTop += card.height + cardGap;
  }

  if (mode.kind === "png") return { canvas };
  return { canvas, layers: { width, height, scale, overlay: canvas, paintBackdrop: (target, frame) => void paintBackdrop(target, frame) } };
}

export type ProfileStatsSummary = {
  /** Ghost Mode: the viewer may not see this user's activity across servers. */
  hidden?: boolean;
  totalMessages: number;
  serverCount: number;
  /** Null when they have no tracked messages yet. */
  globalRank: number | null;
  /** ISO time the numbers are from (00:00 UTC for other viewers); null or absent when live. */
  asOf?: string | null;
  /** Their /daily streak, when known. */
  streak?: number | null;
  /** Messages per day across every server, oldest first. Up to 2 x ACTIVITY_DAYS: the Activity
   *  card shows the last ACTIVITY_DAYS and compares them with the ones before. */
  daily?: number[];
  /** Voice minutes per day across every server, oldest first (the last ACTIVITY_DAYS). */
  voiceDaily?: number[];
  /** Lifetime messages per UTC hour (24 entries), for the active-hours strip. */
  hours?: number[];
};

/** Days the Activity card covers. */
export const ACTIVITY_DAYS = 30;

export type ProfileCardResult =
  | {
      ok: true;
      buffer: Buffer;
      displayName: string;
      stats: ProfileStatsSummary;
      /** When the equipped background is animated: renders the card as a GIF (null if that fails). */
      animate?: () => Promise<Buffer | null>;
    }
  | { ok: false; reason: "private"; displayName: string };

/** Everything the site's profile hero shows, for one user, rendered as the /profile card. */
export async function renderUserProfileCard(client: Client, user: User, viewerId: string): Promise<ProfileCardResult> {
  // Banners aren't on cached users: a forced fetch is needed to see one.
  const fetched = await withTimeout("user fetch", 4_000, client.users.fetch(user.id, { force: true }), user);
  const displayName = fetched.globalName ?? fetched.username;
  const [profile, progression, stats, activity, economy, voice, hourly, firstSeen] = await Promise.all([
    getUserProfile(user.id),
    withTimeout(
      "progression badges",
      5_000,
      getProgressionBadges(client, user.id).then((list) => filterBadgesForAccess(list, canViewCrossServerData(viewerId, user.id))),
      [],
    ),
    // Viewer-aware: live for yourself, a 00:00 UTC snapshot for others, nothing under Ghost Mode.
    Promise.resolve()
      .then(() => globalStatsFor(viewerId, user.id))
      .catch(() => null),
    // Same gate (each asks canViewCrossServerData itself): the Activity card (60 days, so the
    // last 30 can be compared with the 30 before), voice time, active hours, the /daily streak
    // and the first day Dreamliner saw them.
    Promise.resolve()
      .then(() => dailyActivityFor(viewerId, user.id, ACTIVITY_DAYS * 2))
      .catch(() => null),
    Promise.resolve()
      .then(() => globalEconomyFor(viewerId, user.id))
      .catch(() => null),
    Promise.resolve()
      .then(() => dailyVoiceFor(viewerId, user.id, ACTIVITY_DAYS))
      .catch(() => null),
    Promise.resolve()
      .then(() => hourlyActivityFor(viewerId, user.id))
      .catch(() => null),
    Promise.resolve()
      .then(() => firstSeenFor(viewerId, user.id))
      .catch(() => null),
  ]);
  // Same rule as the site: a private profile is only visible to its owner.
  if (!profile.profileVisible && viewerId !== user.id) return { ok: false, reason: "private", displayName };

  const avatarURL = fetched.displayAvatarURL({ size: 512, extension: "png" });
  let accent = profile.accentColor;
  if (!accent) {
    const avatar = await withTimeout("avatar colour", 4_000, loadImageMaybeDataUri(fetched.displayAvatarURL({ size: 128, extension: "png" })), null);
    accent = avatar ? dominantColor(avatar) : SITE.defaultAccent;
  }

  const progressionIcons: ProfileCardData["progressionIcons"] = [];
  for (const badge of progression) {
    const art = await withTimeout("badge art", 3_000, loadBadgeImage(badge.imageKey), null);
    if (!art) continue;
    // The site draws Dreamliner One as its own bolt glyph (0.8rem, accent colored) and every
    // other badge as its art at 13.2px (.lb-hero-name-row .progression-badge-img).
    const details = { id: badge.id, name: badge.name, tierName: badge.tierName, since: badge.since };
    progressionIcons.push(
      badge.id === "dreamliner_one"
        ? { image: art.buffer, tint: toHex(accent), sizeRem: 0.8, ...details }
        : { image: art.buffer, sizeRem: 13.2 / REM, ...details },
    );
  }

  const summary: ProfileStatsSummary =
    stats?.access === "hidden"
      ? { hidden: true, totalMessages: 0, serverCount: 0, globalRank: null }
      : {
          totalMessages: stats?.totalMessages ?? 0,
          serverCount: stats?.serverCount ?? 0,
          globalRank: stats?.globalRank ?? null,
          asOf: stats?.asOf ?? null,
          streak: economy && economy.access !== "hidden" ? economy.streak : null,
          daily: activity && activity.access !== "hidden" ? activity.daily.map((day) => day.messages) : [],
          voiceDaily: voice && voice.access !== "hidden" ? voice.daily.map((day) => day.minutes) : [],
          hours: hourly && hourly.access !== "hidden" ? hourly.hours : [],
        };

  const cardData: ProfileCardData = {
    displayName,
    username: fetched.username,
    avatarURL,
    bannerURL: fetched.bannerURL({ size: 2048, extension: "png" }) ?? null,
    accent,
    progressionIcons,
    // Legacy platform badges are retired: only progression badges are shown.
    badges: [],
    // Ghost Mode (for this viewer) leaves the "Active now / Last seen" pill off.
    lastActiveAt: stats && stats.access !== "hidden" ? stats.lastActiveAt : null,
    cosmetics: (() => {
      try {
        return getEquippedStyle(user.id);
      } catch {
        return null;
      }
    })(),
    accountCreatedAt: fetched.createdAt,
    // On unless they turned it off (the setting may not exist yet: absent counts as on).
    avatarDecorationURL:
      (profile as { showAvatarDecoration?: boolean }).showAvatarDecoration !== false ? staticDecorationUrl(fetched.avatarDecorationURL()) : null,
    // Gated by firstSeenFor itself (null under Ghost Mode).
    firstSeenAt: stats?.access === "hidden" ? null : firstSeen,
    // Built-in badge: kept under Ghost Mode by filterBadgesForAccess, like the bolt itself.
    oneSince: progression.find((badge) => badge.id === "dreamliner_one")?.since ?? null,
    stats: summary,
    // Fixed, so the GIF version (rendered moments later) says the same "last seen".
    now: new Date(),
  };
  const buffer = await renderProfileCard(cardData);
  const background = cardData.cosmetics?.background;
  let animate: (() => Promise<Buffer | null>) | undefined;
  if (hasBackgroundFrames(background, "profile")) {
    // Minute precision for "last seen", so a repeat within the minute reuses the cached GIF.
    const key = animatedCardKey("profile", user.id, background, { ...cardData, now: Math.floor(cardData.now!.getTime() / 60_000) });
    animate = () => cachedAnimatedCard(key, () => renderAnimatedProfileCard(cardData));
  }
  return {
    ok: true,
    buffer,
    animate,
    displayName,
    stats: summary,
  };
}

