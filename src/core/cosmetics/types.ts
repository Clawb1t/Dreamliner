/**
 * Store cosmetics: per-user, global items bought in the Dreamliner Store and equipped one per slot.
 * The resolved style shapes here are the JSON contract shared with the website (camelCase).
 */

export const COSMETIC_SLOTS = [
  "profile_glow",
  "name_font",
  "name_color",
  "avatar_frame",
  "background",
  "title",
  "name_icon",
  "rank_bar",
  "leaderboard_flair",
] as const;
export type CosmeticSlot = (typeof COSMETIC_SLOTS)[number];

export const NAME_COLOR_STYLES = ["solid", "gradient", "shimmer", "neon"] as const;
export const FRAME_PRESETS = ["neon", "gold", "frost", "hearts", "flames", "stars"] as const;
/**
 * Animated backgrounds. The ids must match the website's registry exactly
 * (src/components/backgrounds/index.ts there): the site animates them, the cards draw the
 * still frames the store admin generates from them.
 */
export const BACKGROUND_IDS = [
  "aurora",
  "galaxy",
  "nebula",
  "starfield",
  "shooting-stars",
  "meteors",
  "fireflies",
  "bokeh",
  "snow",
  "rain",
  "ocean",
  "dunes",
  "retro-grid",
  "laser-grid",
  "silk",
  "mesh-gradient",
  "plasma",
  "hologram",
  "prism",
  "warp",
  "portal",
  "eclipse",
  "corona",
  "fireworks",
  "sparkles",
  "matrix",
  "circuit",
  "topography",
  "watercolor",
  "fog",
] as const;
export type BackgroundId = (typeof BACKGROUND_IDS)[number];
export const BAR_STYLES = ["gradient", "striped", "glow"] as const;
export const FLAIR_STYLES = ["glow", "shimmer"] as const;

export type GlowStyle = { colors: string[]; intensity: number };
export type NameFontStyle = { fontId: string };
export type NameColorStyle = { style: (typeof NAME_COLOR_STYLES)[number]; colors: string[] };
export type FrameStyle = { preset: (typeof FRAME_PRESETS)[number]; colors: string[]; imageUrl: string | null };
/**
 * stills: site-relative /api/store/assets/<id> PNGs rendered from the animation at card size.
 * frames: the animation as vertical sprite sheets (every sheet holds frameCount / sheets frames,
 * top to bottom, in order), rendered at the animated cards' GIF size; empty until generated.
 */
export type BackgroundStyle = {
  bgId: BackgroundId;
  colors: string[];
  rankStillUrl: string | null;
  profileStillUrl: string | null;
  rankFramesUrls: string[];
  profileFramesUrls: string[];
  frameCount: number | null;
  fps: number | null;
};
export type TitleStyle = { text: string; color: string | null };
export type IconStyle = { emoji: string | null; imageUrl: string | null };
export type BarStyle = { style: (typeof BAR_STYLES)[number]; colors: string[] };
export type FlairStyle = { style: (typeof FLAIR_STYLES)[number]; color: string };

export type CosmeticStyle = {
  glow?: GlowStyle;
  nameFont?: NameFontStyle;
  nameColor?: NameColorStyle;
  frame?: FrameStyle;
  background?: BackgroundStyle;
  title?: TitleStyle;
  icon?: IconStyle;
  bar?: BarStyle;
  flair?: FlairStyle;
};

export type CosmeticStyleKey = keyof CosmeticStyle;

/** The CosmeticStyle key each slot fills. */
export const SLOT_STYLE_KEY: { [S in CosmeticSlot]: CosmeticStyleKey } = {
  profile_glow: "glow",
  name_font: "nameFont",
  name_color: "nameColor",
  avatar_frame: "frame",
  background: "background",
  title: "title",
  name_icon: "icon",
  rank_bar: "bar",
  leaderboard_flair: "flair",
};

/** What leaderboard rows carry (the rest only shows on profiles and cards). */
export type LeaderboardCosmetics = Pick<CosmeticStyle, "nameFont" | "nameColor" | "frame" | "icon" | "flair" | "bar" | "background">;

/** `background` replaces the member's banner on their row (its /rank still, or live on hover). */
export const LEADERBOARD_STYLE_KEYS = ["nameFont", "nameColor", "frame", "icon", "flair", "bar", "background"] as const;

export function isCosmeticSlot(value: unknown): value is CosmeticSlot {
  return typeof value === "string" && (COSMETIC_SLOTS as readonly string[]).includes(value);
}

/** The leaderboard subset of a resolved style, or null when it has none of those slots. */
export function leaderboardCosmetics(style: CosmeticStyle | undefined | null): LeaderboardCosmetics | null {
  if (!style) return null;
  const out: LeaderboardCosmetics = {};
  let any = false;
  for (const key of LEADERBOARD_STYLE_KEYS) {
    const value = style[key];
    if (value) {
      (out as Record<string, unknown>)[key] = value;
      any = true;
    }
  }
  return any ? out : null;
}
