import { z } from "zod";

/**
 * Frontpage takeovers: the config a superuser builds on the dashboard to replace the website's home
 * page hero. Everything the site renders comes from here, so every colour is a hex value and every
 * link/media URL is http(s) (or a root-relative site path): the site puts these straight into
 * inline styles and attributes. Pure (no DB) so the tests can import it.
 */

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** http(s) absolute URLs, or a path on the site itself ("/dashboard"). Anything else is null. */
export function sanitiseTakeoverUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (/[\u0000-\u001f\u007f\\\s]/.test(trimmed)) return null;
  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//")) return null;
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const color = z.string().trim().regex(HEX_COLOR, "must be a hex colour like #5865f2");

/** Optional URL: empty means none. */
const optionalUrl = z
  .string()
  .max(2048)
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value == null || !value.trim()) return null;
    const safe = sanitiseTakeoverUrl(value);
    if (!safe) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an http(s) URL or a site path starting with /" });
      return z.NEVER;
    }
    return safe;
  });

const requiredUrl = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    const safe = sanitiseTakeoverUrl(value);
    if (!safe) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an http(s) URL or a site path starting with /" });
      return z.NEVER;
    }
    return safe;
  });

const text = (max: number) => z.string().max(max).default("");
const percent = (fallback: number) => z.number().min(0).max(100).default(fallback);
const toggle = z.boolean().default(false);

export const TAKEOVER_BUTTON_ICONS = [
  "arrow-right",
  "external",
  "discord",
  "rocket",
  "spark",
  "star",
  "gift",
  "zap",
  "play",
  "calendar",
  "bell",
  "heart",
  "crown",
  "plane",
  "trophy",
  "download",
] as const;

export const TAKEOVER_IMAGE_POSITIONS = [
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top left",
  "top right",
  "bottom left",
  "bottom right",
] as const;

export const TAKEOVER_ART_POSITIONS = [
  "top-left",
  "top-right",
  "center-left",
  "center-right",
  "bottom-left",
  "bottom-right",
] as const;

const gradientStop = z.object({
  color,
  position: z.number().min(0).max(100),
});

const backgroundSchema = z
  .object({
    type: z.enum(["solid", "gradient", "image", "video"]).default("gradient"),
    color: color.default("#0b1030"),
    gradient: z
      .object({
        kind: z.enum(["linear", "radial"]).default("linear"),
        angle: z.number().min(0).max(360).default(135),
        stops: z
          .array(gradientStop)
          .min(2)
          .max(6)
          .default([
            { color: "#0b1030", position: 0 },
            { color: "#3b2a8f", position: 55 },
            { color: "#5865f2", position: 100 },
          ]),
      })
      .default({}),
    imageUrl: optionalUrl,
    videoUrl: optionalUrl,
    /** Shown instead of imageUrl (and instead of the video) on phones. */
    mobileImageUrl: optionalUrl,
    imagePosition: z.enum(TAKEOVER_IMAGE_POSITIONS).default("center"),
    imageSize: z.enum(["cover", "contain"]).default("cover"),
    /** px */
    blur: z.number().min(0).max(40).default(0),
    overlayColor: color.default("#000000"),
    overlayOpacity: percent(25),
  })
  .default({});

const headlinePart = z.object({
  text: z.string().max(200),
  accent: z.boolean().default(false),
});

const textSchema = z
  .object({
    kicker: text(80),
    headline: z.array(headlinePart).min(1).max(8).default([{ text: "Something big is landing.", accent: false }]),
    subtitle: text(400),
    kickerColor: color.default("#c7ceff"),
    headlineColor: color.default("#ffffff"),
    accentColor: color.default("#8b9dff"),
    subtitleColor: color.default("#e6e8f5"),
    align: z.enum(["left", "center"]).default("left"),
    /** Multiplies the default type sizes. */
    scale: z.number().min(0.6).max(1.6).default(1),
    /** Same, at phone widths. */
    mobileScale: z.number().min(0.6).max(1.4).default(1),
  })
  .default({});

const buttonSchema = z.object({
  label: z.string().trim().min(1, "Every button needs a label.").max(40),
  url: requiredUrl,
  style: z.enum(["primary", "secondary", "ghost"]).default("primary"),
  bgColor: color.nullable().default(null),
  textColor: color.nullable().default(null),
  icon: z.enum(TAKEOVER_BUTTON_ICONS).nullable().default(null),
  newTab: z.boolean().default(false),
});

const artSchema = z
  .object({
    type: z.enum(["none", "side", "float"]).default("none"),
    imageUrl: optionalUrl,
    alt: text(150),
    position: z.enum(TAKEOVER_ART_POSITIONS).default("center-right"),
    /** Percent of the hero's width. */
    size: z.number().min(8).max(60).default(32),
    radius: z.number().min(0).max(48).default(16),
    hideOnMobile: z.boolean().default(false),
  })
  .default({});

const effectsSchema = z
  .object({
    glow: z
      .object({
        enabled: toggle,
        color: color.default("#5865f2"),
        intensity: percent(60),
        target: z.enum(["content", "headline"]).default("content"),
      })
      .default({}),
    textGlow: z.object({ enabled: toggle, color: color.default("#8b9dff"), intensity: percent(50) }).default({}),
    gradientShift: z.object({ enabled: toggle, speed: z.number().min(3).max(60).default(12) }).default({}),
    particles: z
      .object({
        enabled: toggle,
        color: color.default("#ffffff"),
        density: z.number().int().min(5).max(80).default(28),
        style: z.enum(["dots", "sparkles"]).default("sparkles"),
      })
      .default({}),
    shimmer: z.object({ enabled: toggle, color: color.default("#ffffff"), speed: z.number().min(1).max(10).default(3) }).default({}),
    parallax: z.object({ enabled: toggle, intensity: percent(40) }).default({}),
    borderGlow: z.object({ enabled: toggle, color: color.default("#8b9dff"), intensity: percent(55) }).default({}),
    confetti: z
      .object({
        enabled: toggle,
        colors: z.array(color).min(1).max(6).default(["#5865f2", "#8b9dff", "#f472b6", "#facc15", "#34d399"]),
        amount: z.number().int().min(20).max(200).default(90),
      })
      .default({}),
    countdown: z
      .object({
        enabled: toggle,
        targetAt: z.string().max(64).nullable().default(null),
        label: text(60),
        endedLabel: text(60),
        color: color.default("#ffffff"),
      })
      .default({}),
  })
  .default({});

const layoutSchema = z
  .object({
    height: z.enum(["compact", "normal", "tall"]).default("normal"),
    contentWidth: z.enum(["narrow", "normal", "wide", "full"]).default("normal"),
    /** "section" replaces the whole hero card; "content" keeps the default photo card and swaps its copy. */
    mode: z.enum(["section", "content"]).default("section"),
  })
  .default({});

export const takeoverConfigSchema = z
  .object({
    background: backgroundSchema,
    text: textSchema,
    buttons: z.array(buttonSchema).max(3).default([]),
    art: artSchema,
    effects: effectsSchema,
    layout: layoutSchema,
  })
  .superRefine((config, ctx) => {
    if (!config.text.headline.some((part) => part.text.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text", "headline"], message: "The headline can't be empty." });
    }
    if (config.background.type === "image" && !config.background.imageUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["background", "imageUrl"], message: "An image background needs an image URL." });
    }
    if (config.background.type === "video" && !config.background.videoUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["background", "videoUrl"], message: "A video background needs a video URL." });
    }
    if (config.art.type !== "none" && !config.art.imageUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["art", "imageUrl"], message: "The image or art needs an image URL." });
    }
    const stops = config.background.gradient.stops;
    for (let i = 1; i < stops.length; i += 1) {
      if (stops[i]!.position < stops[i - 1]!.position) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["background", "gradient", "stops"],
          message: "Gradient stops must be in order.",
        });
        break;
      }
    }
    const countdown = config.effects.countdown;
    if (countdown.enabled) {
      const at = countdown.targetAt ? new Date(countdown.targetAt) : null;
      if (!at || Number.isNaN(at.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effects", "countdown", "targetAt"], message: "The countdown needs a date." });
      }
    }
  });

export type TakeoverConfig = z.infer<typeof takeoverConfigSchema>;

export class TakeoverConfigError extends Error {}

function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Validate (and fill in defaults for) a config from the dashboard. Throws a readable error. */
export function parseTakeoverConfig(input: unknown): TakeoverConfig {
  const result = takeoverConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map(describeIssue).join("; ");
    throw new TakeoverConfigError(`Invalid takeover config: ${issues}`);
  }
  const config = result.data;
  if (config.effects.countdown.targetAt) {
    config.effects.countdown.targetAt = new Date(config.effects.countdown.targetAt).toISOString();
  }
  return config;
}

/** Same, but null instead of throwing: for rows read back from the DB. */
export function safeParseTakeoverConfig(input: unknown): TakeoverConfig | null {
  try {
    return parseTakeoverConfig(input);
  } catch {
    return null;
  }
}

export type TakeoverWindowRow = {
  enabled: boolean;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  updatedAt: Date;
  id: number;
};

/** Enabled, and "now" is inside its window (an open end means always). */
export function isTakeoverLive(row: TakeoverWindowRow, now: Date): boolean {
  if (!row.enabled) return false;
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return false;
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/** The live takeover: highest priority, then the most recently edited, then the newest id. */
export function pickActiveTakeover<T extends TakeoverWindowRow>(rows: readonly T[], now: Date): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!isTakeoverLive(row, now)) continue;
    if (
      !best ||
      row.priority > best.priority ||
      (row.priority === best.priority &&
        (row.updatedAt.getTime() > best.updatedAt.getTime() ||
          (row.updatedAt.getTime() === best.updatedAt.getTime() && row.id > best.id)))
    ) {
      best = row;
    }
  }
  return best;
}
