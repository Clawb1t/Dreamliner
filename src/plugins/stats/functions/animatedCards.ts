import { createHash } from "node:crypto";
import { createCanvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { loadImageSafe } from "../../../core/safeImage.js";
import { GLOBAL_ASSET_KEY, readPageAsset } from "../../../core/pageAssets.js";
import { offloaded } from "../../../core/offload.js";
import { getLogger } from "../../../core/logger.js";
import { interpolate } from "../../../i18n/catalog.js";
import type { Translator } from "../../../i18n/index.js";
import type { BackgroundStyle } from "../../../core/cosmetics/types.js";
import type { ImageRegion } from "../../../core/cosmetics/canvas.js";
import { loadGifenc } from "../../utility/functions/gifencLoader.js";
import {
  renderLeaderboardLayers,
  renderRankCardLayers,
  type CardLayers,
  type LeaderboardImageOptions,
  type RankCardRow,
} from "./charts.js";
import { renderProfileCardLayers, type ProfileCardData } from "./profileCard.js";

/**
 * Animated (GIF) versions of the /rank, /profile and image leaderboard cards, for members whose
 * equipped background has generated animation frames (sprite sheets the store admin renders in the
 * browser from the website's animation, see BackgroundStyle).
 *
 * Each card is split into its backdrop, painted per frame from the background's frames, and
 * everything over it (avatar, frame, name, badges, ring, text), rendered once onto a transparent
 * overlay and composited onto every frame. All frames share one palette: the overlay's common
 * colours reserved exactly, the rest quantized from pixels sampled across every frame. Only the
 * background is dithered (an ordered dither, stable from frame to frame), so the text over the
 * animation is pixel-identical (and crisp) in every frame while gradients don't band; pixels that
 * don't change from the previous frame are written as transparent, which keeps the static parts of
 * the card almost free in the file.
 *
 * The GIFs render at /rank 3x and /profile 2x. Frames generated at that size are drawn 1:1; older,
 * lower-resolution frame sets are upscaled smoothly (soft backgrounds), with the overlay still
 * drawn natively at the output scale.
 *
 * Rendering and encoding run on a worker thread (offload.ts) with a deadline and never fall back to
 * the main thread. The commands send the still PNG first and swap in the GIF when it is ready.
 */

const log = getLogger("stats");

/** Discord's default upload limit for bots is 10MB; keep a safety margin under it. */
export const MAX_GIF_BYTES = 9 * 1024 * 1024;
export const GIF_TIMEOUT_MS = 15_000;
const MODULE = "plugins/stats/functions/animatedCards";

// --- Frames -------------------------------------------------------------------------------------

const STORE_ASSET = /^\/api\/store\/assets\/([a-zA-Z0-9_-]{1,64})$/;
/** Decoded sprite sheets, least recently used first, capped by total pixels (~4 bytes each). */
const sheetCache = new Map<string, Image>();
const MAX_CACHED_PIXELS = 24_000_000;
let cachedPixels = 0;

async function loadSheet(url: string): Promise<Image | null> {
  const cached = sheetCache.get(url);
  if (cached) {
    sheetCache.delete(url);
    sheetCache.set(url, cached);
    return cached;
  }
  const id = STORE_ASSET.exec(url)?.[1];
  const buffer = id ? readPageAsset(GLOBAL_ASSET_KEY, "store", id) : null;
  if (!buffer) return null;
  const image = await loadImageSafe(buffer).catch(() => null);
  if (!image?.width || !image.height) return null;
  sheetCache.set(url, image);
  cachedPixels += image.width * image.height;
  while (cachedPixels > MAX_CACHED_PIXELS && sheetCache.size > 1) {
    const [oldUrl, old] = sheetCache.entries().next().value!;
    sheetCache.delete(oldUrl);
    cachedPixels -= old.width * old.height;
  }
  return image;
}

/** For tests: drops the decoded sheets. */
export function clearFrameCache(): void {
  sheetCache.clear();
  cachedPixels = 0;
}

export type FramesKind = "rank" | "profile";

function frameUrls(background: BackgroundStyle | null | undefined, kind: FramesKind): string[] {
  return (kind === "rank" ? background?.rankFramesUrls : background?.profileFramesUrls) ?? [];
}

/** Whether an equipped background can be animated on this card. */
export function hasBackgroundFrames(background: BackgroundStyle | null | undefined, kind: FramesKind): boolean {
  const urls = frameUrls(background, kind);
  const count = background?.frameCount ?? 0;
  return Boolean(background?.fps && count >= 2 && urls.length > 0 && count % urls.length === 0);
}

/**
 * A background's frames, in order: every sheet holds frameCount / sheets frames stacked top to
 * bottom. Null when a sheet is missing or unreadable.
 */
export async function loadBackgroundFrames(background: BackgroundStyle | null | undefined, kind: FramesKind): Promise<ImageRegion[] | null> {
  if (!background || !hasBackgroundFrames(background, kind)) return null;
  const urls = frameUrls(background, kind);
  const perSheet = background.frameCount! / urls.length;
  const sheets = await Promise.all(urls.map(loadSheet));
  if (sheets.some((sheet) => !sheet)) return null;
  const frames: ImageRegion[] = [];
  for (const sheet of sheets as Image[]) {
    const frameHeight = sheet.height / perSheet;
    for (let k = 0; k < perSheet; k++) {
      frames.push({ image: sheet, sx: 0, sy: Math.round(k * frameHeight), sw: sheet.width, sh: Math.floor(frameHeight) });
    }
  }
  return frames;
}

// --- GIF encoding -------------------------------------------------------------------------------

export type AnimationSpec = {
  /** Output pixels. */
  width: number;
  height: number;
  frames: number;
  fps: number;
  /** Draws frame `index` onto a cleared canvas (identity transform). */
  drawFrame: (ctx: SKRSContext2D, index: number) => void;
  /**
   * The static overlay drawn over every frame (RGBA, width×height), when there is one. Its opaque
   * pixels get exact palette colours (the most common ones reserved outright) and are never
   * dithered; only the pixels it doesn't cover are dithered.
   */
  overlay?: Uint8ClampedArray | null;
  /** Ordered-dither strength for background pixels: 0 (none) to 1. */
  dither?: number;
  /** Stops with a GifTooLargeError once the GIF is (or is on course to be) over this many bytes. */
  maxBytes?: number;
  /** Epoch ms; encoding stops with an error past it. */
  deadline?: number;
};

/** An encode stopped early: the GIF was over (or projected over) the byte budget. */
export class GifTooLargeError extends Error {
  constructor(readonly projectedBytes: number) {
    super(`animated card is too large (about ${projectedBytes} bytes)`);
  }
}

const TRANSPARENT = 255;
/** At most this many of the overlay's most common colours are reserved exactly in the palette. */
const MAX_RESERVED_COLOURS = 64;
/** Pixels sampled (across every frame) to quantize the background's colours. */
const SAMPLE_BUDGET = 1_200_000;
/** Dither spread at strength 1, in 0–255 channel units (about one palette step in a dark gradient). */
const DITHER_SPREAD = 14;
/** Past this fraction of the frames, an encode whose projected size is over budget stops early. */
const PROJECTION_AFTER = 0.3;
const PROJECTION_MARGIN = 1.2;

/**
 * 8×8 Bayer thresholds centred on zero (-0.5..0.5). An ordered dither is fixed in screen space, so
 * a background pixel whose colour doesn't change keeps its dithered value from frame to frame:
 * no error-diffusion shimmer, and the unchanged-pixel transparency still works.
 */
const BAYER_8 = (() => {
  let m = [[0]];
  for (let k = 0; k < 3; k++) {
    const n = m.length;
    const next = Array.from({ length: n * 2 }, () => new Array<number>(n * 2).fill(0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = m[y]![x]! * 4;
        next[y]![x] = v;
        next[y]![x + n] = v + 2;
        next[y + n]![x] = v + 3;
        next[y + n]![x + n] = v + 1;
      }
    }
    m = next;
  }
  return Float32Array.from(m.flat(), (v) => (v + 0.5) / 64 - 0.5);
})();

/** Overlay coverage per pixel: 2 opaque (exact colour, never dithered), 1 partly covered, 0 none. */
export const MASK_OVERLAY = 2;
export const MASK_EDGE = 1;
export const MASK_BACKGROUND = 0;

export type AnimationQuantizer = {
  /** 256 entries; index 255 is transparent. */
  palette: number[][];
  /** How many leading palette entries are the overlay's exact, reserved colours. */
  reserved: number;
  /** Per pixel: MASK_OVERLAY / MASK_EDGE / MASK_BACKGROUND. */
  mask: Uint8Array;
  /** Writes the palette indices of one composed RGBA frame into `out`. */
  map: (data: Uint8ClampedArray, out: Uint8Array) => void;
};

type Quantize = Awaited<ReturnType<typeof loadGifenc>>["quantize"];

function makeDrawer(spec: Pick<AnimationSpec, "width" | "height" | "drawFrame">): (index: number) => Uint8ClampedArray {
  const canvas = createCanvas(spec.width, spec.height);
  const ctx = canvas.getContext("2d");
  return (index) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, spec.width, spec.height);
    spec.drawFrame(ctx, index);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx.getImageData(0, 0, spec.width, spec.height).data;
  };
}

/**
 * One palette for the whole animation, so a colour always lands on the same index in every frame
 * (which keeps the overlay identical and lets unchanged pixels be written as transparent):
 * - first the overlay's most common opaque colours, exactly (text, chips, ring, card fills);
 * - the rest quantized from pixels sampled across every frame (the background, the overlay's
 *   partly covered edges) plus the rest of the overlay, so it is weighted towards the background.
 * Background pixels get an ordered dither before the palette lookup; overlay pixels never do, and
 * their indices are worked out once from the overlay itself.
 */
export function buildAnimationQuantizer(
  quantize: Quantize,
  spec: Pick<AnimationSpec, "width" | "height" | "frames" | "overlay" | "dither" | "deadline">,
  frame: (index: number) => Uint8ClampedArray,
): AnimationQuantizer {
  const { width, height, frames, overlay } = spec;
  const pixels = width * height;
  const mask = new Uint8Array(pixels);

  // Overlay colours, most common first.
  const reservedKeys: number[] = [];
  let opaque = 0;
  const overlayCounts = new Map<number, number>();
  if (overlay) {
    for (let p = 0, q = 0; p < pixels; p++, q += 4) {
      const a = overlay[q + 3]!;
      if (a === 255) {
        mask[p] = MASK_OVERLAY;
        opaque++;
        const key = (overlay[q]! << 16) | (overlay[q + 1]! << 8) | overlay[q + 2]!;
        overlayCounts.set(key, (overlayCounts.get(key) ?? 0) + 1);
      } else if (a > 0) {
        mask[p] = MASK_EDGE;
      }
    }
    const minCount = Math.max(12, Math.ceil(opaque / 5000));
    const common = [...overlayCounts].filter(([, count]) => count >= minCount).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const [key] of common.slice(0, MAX_RESERVED_COLOURS)) reservedKeys.push(key);
  }
  const reservedSet = new Set(reservedKeys);

  // Samples: background and edge pixels from every frame (a different offset each frame, so the
  // stride covers the whole card), and every opaque overlay pixel that isn't reserved, once.
  const uncovered = pixels - opaque;
  const stride = Math.max(1, Math.ceil((uncovered * frames) / SAMPLE_BUDGET));
  let overlaySamples = 0;
  for (const [key, count] of overlayCounts) if (!reservedSet.has(key)) overlaySamples += count;
  const capacity = (Math.ceil(pixels / stride) + 1) * frames + overlaySamples + 1;
  const samples = new Uint8Array(capacity * 4);
  let n = 0;
  for (let i = 0; i < frames; i++) {
    const data = frame(i);
    for (let p = (i * 7919) % stride; p < pixels; p += stride) {
      const q = p * 4;
      if (mask[p] === MASK_OVERLAY || data[q + 3]! < 128) continue;
      samples[n * 4] = data[q]!;
      samples[n * 4 + 1] = data[q + 1]!;
      samples[n * 4 + 2] = data[q + 2]!;
      samples[n * 4 + 3] = 255;
      n++;
    }
    checkDeadline(spec.deadline);
  }
  if (overlay) {
    for (let p = 0, q = 0; p < pixels; p++, q += 4) {
      if (mask[p] !== MASK_OVERLAY) continue;
      const key = (overlay[q]! << 16) | (overlay[q + 1]! << 8) | overlay[q + 2]!;
      if (reservedSet.has(key)) continue;
      samples[n * 4] = overlay[q]!;
      samples[n * 4 + 1] = overlay[q + 1]!;
      samples[n * 4 + 2] = overlay[q + 2]!;
      samples[n * 4 + 3] = 255;
      n++;
    }
  }

  const palette: number[][] = reservedKeys.map((key) => [(key >> 16) & 255, (key >> 8) & 255, key & 255]);
  const free = 255 - palette.length;
  if (n > 0 && free > 0) {
    for (const colour of quantize(samples.subarray(0, n * 4), free, { format: "rgb565" }).slice(0, free)) palette.push([colour[0]!, colour[1]!, colour[2]!]);
  }
  if (palette.length === 0) palette.push([0, 0, 0]);
  const used = Math.min(palette.length, 255);
  while (palette.length < 256) palette.push([0, 0, 0]);

  const nearest = (r: number, g: number, b: number): number => {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < used; i++) {
      const c = palette[i]!;
      const dr = c[0]! - r;
      const dg = c[1]! - g;
      const db = c[2]! - b;
      const distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  };

  // The overlay's indices, once: reserved colours map to themselves, the rest to their nearest.
  const overlayIndex = new Uint8Array(pixels);
  if (overlay) {
    const exact = new Map<number, number>();
    reservedKeys.forEach((key, index) => exact.set(key, index));
    for (let p = 0, q = 0; p < pixels; p++, q += 4) {
      if (mask[p] !== MASK_OVERLAY) continue;
      const key = (overlay[q]! << 16) | (overlay[q + 1]! << 8) | overlay[q + 2]!;
      let index = exact.get(key);
      if (index === undefined) {
        index = nearest(overlay[q]!, overlay[q + 1]!, overlay[q + 2]!);
        exact.set(key, index);
      }
      overlayIndex[p] = index;
    }
  }

  // Everything else: nearest entry per 6-bit-per-channel bucket (by its centre, so the mapping
  // doesn't depend on which pixel turned up first), filled in as buckets are used.
  const lookup = new Int16Array(1 << 18).fill(-1);
  const amplitude = Math.max(0, Math.min(1, spec.dither ?? 0)) * DITHER_SPREAD;
  const map = (data: Uint8ClampedArray, out: Uint8Array): void => {
    for (let y = 0, p = 0; y < height; y++) {
      const row = (y & 7) << 3;
      for (let x = 0; x < width; x++, p++) {
        const m = mask[p]!;
        if (m === MASK_OVERLAY) {
          out[p] = overlayIndex[p]!;
          continue;
        }
        const q = p * 4;
        if (data[q + 3]! < 128) {
          out[p] = TRANSPARENT;
          continue;
        }
        let r = data[q]!;
        let g = data[q + 1]!;
        let b = data[q + 2]!;
        if (m === MASK_BACKGROUND && amplitude > 0) {
          const offset = BAYER_8[row | (x & 7)]! * amplitude;
          r = Math.min(255, Math.max(0, Math.round(r + offset)));
          g = Math.min(255, Math.max(0, Math.round(g + offset)));
          b = Math.min(255, Math.max(0, Math.round(b + offset)));
        }
        const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
        let index = lookup[key]!;
        if (index < 0) {
          index = nearest(((r >> 2) << 2) + 2, ((g >> 2) << 2) + 2, ((b >> 2) << 2) + 2);
          lookup[key] = index;
        }
        out[p] = index;
      }
    }
  };
  return { palette, reserved: reservedKeys.length, mask, map };
}

function checkDeadline(deadline: number | undefined): void {
  if (deadline !== undefined && Date.now() > deadline) throw new Error("animated card timed out");
}

/** RGBA frames (each width×height×4), as the encoder sees them: for tests and diagnostics. */
export function composeFrames(spec: Pick<AnimationSpec, "width" | "height" | "frames" | "drawFrame">): Uint8ClampedArray[] {
  const draw = makeDrawer(spec);
  return Array.from({ length: spec.frames }, (_, i) => new Uint8ClampedArray(draw(i)));
}

/** Every frame's palette indices (before the unchanged-pixel transparency): for tests. */
export async function quantizeAnimation(spec: AnimationSpec): Promise<AnimationQuantizer & { frames: Uint8Array[] }> {
  const { quantize } = await loadGifenc();
  const draw = makeDrawer(spec);
  const quantizer = buildAnimationQuantizer(quantize, spec, draw);
  const frames = Array.from({ length: spec.frames }, (_, i) => {
    const out = new Uint8Array(spec.width * spec.height);
    quantizer.map(draw(i), out);
    return out;
  });
  return { ...quantizer, frames };
}

/** Per-frame delays in ms (whole centiseconds) that add up to the exact loop length. */
export function frameDelays(frames: number, fps: number): number[] {
  return Array.from({ length: frames }, (_, i) => (Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps)) * 10);
}

/**
 * A looping GIF of `spec` with one global palette (see buildAnimationQuantizer), every pixel that
 * matches the previous frame written as transparent (disposal "keep"), so unchanged parts of the
 * card cost almost nothing.
 */
export async function encodeAnimation(spec: AnimationSpec): Promise<Buffer> {
  const { GIFEncoder, quantize } = await loadGifenc();
  const { width, height, frames } = spec;
  const draw = makeDrawer(spec);
  const { palette, map } = buildAnimationQuantizer(quantize, spec, draw);

  const gif = GIFEncoder({ initialCapacity: 1 << 20 });
  const delays = frameDelays(frames, spec.fps);
  const pixels = width * height;
  let indices = new Uint8Array(pixels);
  let previous = new Uint8Array(pixels);
  const written = new Uint8Array(pixels);
  let firstBytes = 0;
  for (let i = 0; i < frames; i++) {
    map(draw(i), indices);
    let out = indices;
    if (i > 0) {
      for (let p = 0; p < pixels; p++) written[p] = indices[p] === previous[p] ? TRANSPARENT : indices[p]!;
      out = written;
    }
    gif.writeFrame(out, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: delays[i],
      transparent: true,
      transparentIndex: TRANSPARENT,
      dispose: 1,
      repeat: 0,
    });
    [previous, indices] = [indices, previous];
    checkDeadline(spec.deadline);
    if (spec.maxBytes !== undefined) {
      const bytes = gif.bytesView().length;
      if (i === 0) firstBytes = bytes;
      if (bytes > spec.maxBytes) throw new GifTooLargeError(Math.round(firstBytes + ((bytes - firstBytes) / Math.max(1, i)) * (frames - 1)));
      // The first frame is a full image; the rest are deltas, so project from those.
      if (i >= 2 && i >= frames * PROJECTION_AFTER) {
        const projected = firstBytes + ((bytes - firstBytes) / i) * (frames - 1);
        if (projected > spec.maxBytes * PROJECTION_MARGIN) throw new GifTooLargeError(Math.round(projected));
      }
    }
  }
  gif.finish();
  const bytes = gif.bytesView().length;
  if (spec.maxBytes !== undefined && bytes > spec.maxBytes) throw new GifTooLargeError(bytes);
  return Buffer.from(gif.bytes());
}

// --- Cards --------------------------------------------------------------------------------------

export type AnimatedCardResult = {
  gif: Uint8Array;
  width: number;
  height: number;
  frames: number;
  fps: number;
  scale: number;
  /** The dither strength used (0: none). */
  dither: number;
  /**
   * The background frames are at the GIF's resolution (same width), not upscaled from an older,
   * smaller set. A card taller than the frames (a title line) still cover-fits them slightly.
   */
  nativeFrames: boolean;
  bytes: number;
  ms: number;
};

/** Output scale, frame step (2 = every other frame at half the rate) and dither strength to try, in order. */
export type GifAttempt = { scale: number; step: number; dither: number };

/**
 * The size guard's step-down: less dithering first (it costs bytes on busy backgrounds), then
 * fewer frames over the same loop, then a smaller card. Only when nothing fits does the still stay.
 */
function stepDown(scales: number[], steps: number[], dithers: number[] = [1, 0.5, 0]): GifAttempt[] {
  const attempts: GifAttempt[] = [];
  const [first, ...smaller] = scales;
  for (const [s, step] of steps.entries()) {
    for (const dither of s === 0 ? dithers : [0]) attempts.push({ scale: first!, step, dither });
  }
  for (const scale of smaller) attempts.push({ scale, step: steps[steps.length - 1]!, dither: 0 });
  return attempts;
}

/** /rank: 1380px wide (scale 3 of the 460-unit card), the current frames' own size. */
export const RANK_GIF_ATTEMPTS: GifAttempt[] = stepDown([3, 2, 1.5], [1, 2]);
/** /profile: 1520px wide (scale 2 of the 760-unit card), the current frames' own size. */
export const PROFILE_GIF_ATTEMPTS: GifAttempt[] = stepDown([2, 1.5, 1], [1, 2]);
/** The image leaderboard: 1100px wide, every other frame. */
export const LEADERBOARD_GIF_ATTEMPTS: GifAttempt[] = stepDown([1, 0.75], [2, 4]);
/** At most this many leaderboard rows animate (the rest keep their still). */
export const MAX_ANIMATED_LEADERBOARD_ROWS = 4;
/** An attempt this far over budget skips the rest of the dither step-down at its scale and rate. */
const HOPELESS_RATIO = 1.6;

type Layered = {
  scale: number;
  overlay: CardLayers["overlay"];
  paint: (ctx: SKRSContext2D, frame: number) => void;
  /** Pixel width of the background frames, when they fill the whole card (rank/profile). */
  frameWidth?: number;
};

/** Encodes `layersFor` at each attempt until the GIF fits in `maxBytes`. */
export async function encodeLayeredCard(
  layersFor: (scale: number) => Promise<Layered>,
  frameCount: number,
  fps: number,
  attempts: GifAttempt[],
  options: { maxBytes?: number; deadline?: number } = {},
): Promise<AnimatedCardResult> {
  const started = Date.now();
  const maxBytes = options.maxBytes ?? MAX_GIF_BYTES;
  let lastBytes = 0;
  let layers: (Layered & { pixels: Uint8ClampedArray }) | null = null;
  const hopeless = new Set<string>();
  for (const attempt of attempts) {
    const group = `${attempt.scale}:${attempt.step}`;
    if (hopeless.has(group)) continue;
    if (!layers || layers.scale !== attempt.scale) {
      const next = await layersFor(attempt.scale);
      const { width, height } = next.overlay;
      layers = { ...next, pixels: next.overlay.getContext("2d").getImageData(0, 0, width, height).data };
    }
    const current = layers;
    const picks = Array.from({ length: Math.max(1, Math.floor(frameCount / attempt.step)) }, (_, i) => i * attempt.step);
    const rate = fps / attempt.step;
    const { width, height } = current.overlay;
    let gif: Buffer;
    try {
      gif = await encodeAnimation({
        width,
        height,
        frames: picks.length,
        fps: rate,
        overlay: current.pixels,
        dither: attempt.dither,
        maxBytes,
        deadline: options.deadline,
        drawFrame: (ctx, index) => {
          // Frames at another size (older, lower-resolution sets) are resampled smoothly: they're
          // soft backgrounds, and the text over them is drawn natively at this scale.
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.setTransform(current.scale, 0, 0, current.scale, 0, 0);
          current.paint(ctx, picks[index]!);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(current.overlay, 0, 0);
        },
      });
    } catch (error) {
      if (!(error instanceof GifTooLargeError)) throw error;
      lastBytes = error.projectedBytes;
      if (error.projectedBytes > maxBytes * HOPELESS_RATIO) hopeless.add(group);
      continue;
    }
    return {
      gif,
      width,
      height,
      frames: picks.length,
      fps: rate,
      scale: attempt.scale,
      dither: attempt.dither,
      nativeFrames: current.frameWidth === width,
      bytes: gif.length,
      ms: Date.now() - started,
    };
  }
  throw new Error(`animated card is too large (${lastBytes} bytes at the smallest size)`);
}

/** The translations a card used, replayed in the worker (a Translator can't cross threads). */
export type TranslationEntries = Array<[string, string]>;

function translationKey(key: string, vars?: Record<string, string | number>): string {
  return `${key}\u0000${vars ? JSON.stringify(vars) : ""}`;
}

export function recordTranslations(t: Translator): { t: Translator; entries: () => TranslationEntries } {
  const seen = new Map<string, string>();
  return {
    t: (key, fallback, vars) => {
      const value = t(key, fallback, vars);
      seen.set(translationKey(key, vars), value);
      return value;
    },
    entries: () => [...seen.entries()],
  };
}

export function replayTranslator(entries: TranslationEntries): Translator {
  const known = new Map(entries);
  return (key, fallback, vars) => known.get(translationKey(key, vars)) ?? interpolate(fallback, vars);
}

/** Buffers arrive from the main thread as plain Uint8Arrays. */
function asBuffer(value: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export type AnimatedCardOptions = { maxBytes?: number; timeoutMs?: number; attempts?: GifAttempt[] };

export async function renderAnimatedRankCardImpl(
  row: RankCardRow,
  translations: TranslationEntries,
  options: AnimatedCardOptions = {},
): Promise<AnimatedCardResult> {
  const deadline = Date.now() + (options.timeoutMs ?? GIF_TIMEOUT_MS - 500);
  const background = row.cosmetics?.background;
  const frames = await loadBackgroundFrames(background, "rank");
  if (!frames || !background) throw new Error("the background has no animation frames");
  const revived: RankCardRow = { ...row, progressionIcons: row.progressionIcons?.map((icon) => ({ ...icon, image: asBuffer(icon.image) })) };
  const t = replayTranslator(translations);
  return encodeLayeredCard(
    async (scale) => {
      const layers = await renderRankCardLayers({ row: revived, scale }, frames[0]!, t);
      return { scale, overlay: layers.overlay, frameWidth: frames[0]!.sw, paint: (ctx, i) => layers.paintBackdrop(ctx, frames[i % frames.length]!) };
    },
    frames.length,
    background.fps!,
    options.attempts ?? RANK_GIF_ATTEMPTS,
    { maxBytes: options.maxBytes, deadline },
  );
}

export async function renderAnimatedProfileCardImpl(data: ProfileCardData, options: AnimatedCardOptions = {}): Promise<AnimatedCardResult> {
  const deadline = Date.now() + (options.timeoutMs ?? GIF_TIMEOUT_MS - 500);
  const background = data.cosmetics?.background;
  const frames = await loadBackgroundFrames(background, "profile");
  if (!frames || !background) throw new Error("the background has no animation frames");
  const revived: ProfileCardData = {
    ...data,
    progressionIcons: data.progressionIcons.map((icon) => ({ ...icon, image: asBuffer(icon.image) })),
  };
  return encodeLayeredCard(
    async (scale) => {
      const layers = await renderProfileCardLayers(revived, { scale }, frames[0]!);
      return { scale, overlay: layers.overlay, frameWidth: frames[0]!.sw, paint: (ctx, i) => layers.paintBackdrop(ctx, frames[i % frames.length]!) };
    },
    frames.length,
    background.fps!,
    options.attempts ?? PROFILE_GIF_ATTEMPTS,
    { maxBytes: options.maxBytes, deadline },
  );
}

export async function renderAnimatedLeaderboardImpl(
  leaderboard: LeaderboardImageOptions,
  translations: TranslationEntries,
  options: AnimatedCardOptions = {},
): Promise<AnimatedCardResult> {
  const deadline = Date.now() + (options.timeoutMs ?? GIF_TIMEOUT_MS - 500);
  const rows = leaderboard.rows.slice(0, 10);
  const rowFrames: Array<ImageRegion[] | null> = [];
  let animated = 0;
  let frameCount = 0;
  let fps = 0;
  for (const row of rows) {
    const background = row.cosmetics?.background;
    const frames = animated < MAX_ANIMATED_LEADERBOARD_ROWS ? await loadBackgroundFrames(background, "rank") : null;
    rowFrames.push(frames);
    if (frames && background) {
      animated++;
      // One timeline for every row: the first animated row's (backgrounds share the defaults).
      if (!frameCount) {
        frameCount = frames.length;
        fps = background.fps!;
      }
    }
  }
  if (!animated) throw new Error("no listed row has an animated background");
  const t = replayTranslator(translations);
  return encodeLayeredCard(
    async (scale) => {
      const layers = await renderLeaderboardLayers({ ...leaderboard, rows, scale }, rowFrames, t);
      return { scale, overlay: layers.overlay, paint: layers.paintBackdrop };
    },
    frameCount,
    fps,
    options.attempts ?? LEADERBOARD_GIF_ATTEMPTS,
    { maxBytes: options.maxBytes, deadline },
  );
}

const onWorker = { timeoutMs: GIF_TIMEOUT_MS, mainThreadFallback: false } as const;
/** On a worker thread; rejects (never blocks the bot) when no worker can take it. */
export const renderAnimatedRankCard = offloaded(MODULE, "renderAnimatedRankCard", renderAnimatedRankCardImpl, onWorker);
export const renderAnimatedProfileCard = offloaded(MODULE, "renderAnimatedProfileCard", renderAnimatedProfileCardImpl, onWorker);
export const renderAnimatedLeaderboard = offloaded(MODULE, "renderAnimatedLeaderboard", renderAnimatedLeaderboardImpl, onWorker);

// --- Main-thread cache ------------------------------------------------------------------------

const GIF_CACHE_MS = 5 * 60_000;
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const gifCache = new Map<string, { at: number; buffer: Buffer }>();
const inflight = new Map<string, Promise<Buffer | null>>();
let cacheBytes = 0;

function dropCached(key: string): void {
  const entry = gifCache.get(key);
  if (!entry) return;
  gifCache.delete(key);
  cacheBytes -= entry.buffer.length;
}

/** A stable key for a card: its kind, owner, background and frames, and a hash of everything drawn. */
export function animatedCardKey(kind: string, ownerId: string, background: BackgroundStyle | null | undefined, data: unknown): string {
  const frames = createHash("sha1")
    .update(JSON.stringify([background?.rankFramesUrls ?? [], background?.profileFramesUrls ?? [], background?.frameCount, background?.fps]))
    .digest("hex")
    .slice(0, 12);
  const hash = createHash("sha1").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `${kind}:${ownerId}:${background?.bgId ?? "-"}:${frames}:${hash}`;
}

/**
 * The GIF for `key`, from the cache (a few minutes) or `render`; null when it fails or times out
 * (the caller keeps the still). Concurrent requests for the same card share one render.
 */
export async function cachedAnimatedCard(key: string, render: () => Promise<AnimatedCardResult>): Promise<Buffer | null> {
  const now = Date.now();
  for (const [cachedKey, entry] of gifCache) if (now - entry.at > GIF_CACHE_MS) dropCached(cachedKey);
  const hit = gifCache.get(key);
  if (hit) return hit.buffer;
  const running = inflight.get(key);
  if (running) return running;
  const task = (async () => {
    try {
      const result = await render();
      const buffer = asBuffer(result.gif);
      log.debug(`[animated card] ${key.split(":")[0]} ${result.width}x${result.height}, ${result.frames} frames at ${result.fps}fps, ${buffer.length} bytes in ${result.ms}ms`);
      gifCache.set(key, { at: Date.now(), buffer });
      cacheBytes += buffer.length;
      while (cacheBytes > MAX_CACHE_BYTES && gifCache.size > 1) dropCached(gifCache.keys().next().value!);
      return buffer;
    } catch (error) {
      log.warn(`[animated card] ${key.split(":")[0]} kept the still: ${error instanceof Error ? error.message : error}`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/** For tests. */
export function clearAnimatedCardCache(): void {
  gifCache.clear();
  inflight.clear();
  cacheBytes = 0;
}
