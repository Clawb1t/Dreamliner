import { z } from "zod";
import { NAME_FONT_IDS } from "./fonts.js";
import {
  BACKGROUND_IDS,
  BAR_STYLES,
  FLAIR_STYLES,
  FRAME_PRESETS,
  NAME_COLOR_STYLES,
  SLOT_STYLE_KEY,
  type CosmeticSlot,
  type CosmeticStyle,
} from "./types.js";

/**
 * Per-slot validation of a cosmetic product's config. A product stores `{ slot, style }` where
 * `style` is the slot's own settings; uploaded art is stored by asset id and resolved to its
 * site-relative URL (/api/store/assets/<id>) in the payloads.
 */

const ASSET_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ASSET_URL = /^\/api\/store\/assets\/([a-zA-Z0-9_-]{1,64})$/;

const hex = z
  .string()
  .trim()
  .regex(/^#?[0-9a-fA-F]{6}$/, "must be a #rrggbb color")
  .transform((value) => (value.startsWith("#") ? value : `#${value}`).toLowerCase());

const colors = (min: number, max: number) => z.array(hex).min(min).max(max);

/** An uploaded image: an asset id, or its /api/store/assets/<id> URL. Null for none. */
const assetRef = z
  .union([z.string().trim(), z.null()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === null || value === "") return null;
    const fromUrl = ASSET_URL.exec(value)?.[1];
    const id = fromUrl ?? value;
    if (!ASSET_ID.test(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "isn't a valid uploaded image" });
      return z.NEVER;
    }
    return id;
  });

/** A list of uploaded images (asset ids or their URLs), e.g. a background's frame sheets. */
const assetRefList = z
  .union([z.array(z.string().trim()).max(24), z.null()])
  .optional()
  .transform((value, ctx) => {
    if (!value) return null;
    const ids: string[] = [];
    for (const item of value) {
      const id = ASSET_URL.exec(item)?.[1] ?? item;
      if (!ASSET_ID.test(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "isn't a valid uploaded image" });
        return z.NEVER;
      }
      ids.push(id);
    }
    return ids;
  });

/** Reads an image from either `imageAssetId` or `imageUrl` (the resolved payload form). */
function withAsset<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ ...shape, imageAssetId: assetRef, imageUrl: assetRef })
    .transform(({ imageAssetId, imageUrl, ...rest }) => ({ ...rest, imageAssetId: imageAssetId ?? imageUrl ?? null }));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const SLOT_SCHEMAS = {
  profile_glow: z.object({ colors: colors(1, 3), intensity: z.number().min(0.3).max(1) }),
  name_font: z.object({ fontId: z.enum(NAME_FONT_IDS) }),
  name_color: z
    .object({ style: z.enum(NAME_COLOR_STYLES), colors: colors(1, 4) })
    .refine((value) => (value.style === "gradient" || value.style === "shimmer" ? value.colors.length >= 2 : true), {
      message: "gradient and shimmer need at least 2 colors",
      path: ["colors"],
    }),
  avatar_frame: withAsset({ preset: z.enum(FRAME_PRESETS), colors: colors(1, 3) }),
  // Stills are read from `*StillAssetId` or the resolved `*StillUrl` form, like withAsset.
  background: z
    .object({
      bgId: z.enum(BACKGROUND_IDS),
      colors: colors(0, 4).default([]),
      rankStillAssetId: assetRef,
      rankStillUrl: assetRef,
      profileStillAssetId: assetRef,
      profileStillUrl: assetRef,
      // The animation's sprite sheets for the GIF cards (see BackgroundStyle), ids or URLs.
      rankFramesAssetIds: assetRefList,
      rankFramesUrls: assetRefList,
      profileFramesAssetIds: assetRefList,
      profileFramesUrls: assetRefList,
      frameCount: z.number().int().min(2).max(60).nullable().optional(),
      fps: z.number().min(1).max(30).nullable().optional(),
    })
    .transform(
      ({
        rankStillAssetId,
        rankStillUrl,
        profileStillAssetId,
        profileStillUrl,
        rankFramesAssetIds,
        rankFramesUrls,
        profileFramesAssetIds,
        profileFramesUrls,
        frameCount,
        fps,
        ...rest
      }) => {
        const rankFrames = rankFramesAssetIds ?? rankFramesUrls ?? [];
        const profileFrames = profileFramesAssetIds ?? profileFramesUrls ?? [];
        const hasFrames = Boolean(frameCount && fps && (rankFrames.length || profileFrames.length));
        return {
          ...rest,
          rankStillAssetId: rankStillAssetId ?? rankStillUrl ?? null,
          profileStillAssetId: profileStillAssetId ?? profileStillUrl ?? null,
          // Frames are only usable together with their count and rate.
          rankFramesAssetIds: hasFrames ? rankFrames : [],
          profileFramesAssetIds: hasFrames ? profileFrames : [],
          frameCount: hasFrames ? frameCount! : null,
          fps: hasFrames ? fps! : null,
        };
      },
    ),
  title: z.object({ text: z.string().trim().min(1).max(32), color: hex.nullable().default(null) }),
  name_icon: withAsset({
    emoji: z
      .string()
      .trim()
      .max(32)
      .nullable()
      .default(null)
      .transform((value) => value || null)
      .refine((value) => value === null || [...graphemes.segment(value)].length === 1, "must be a single emoji"),
  }).refine((value) => value.emoji !== null || value.imageAssetId !== null, "needs an emoji or an image"),
  rank_bar: z.object({ style: z.enum(BAR_STYLES), colors: colors(1, 3) }),
  leaderboard_flair: z.object({ style: z.enum(FLAIR_STYLES), color: hex }),
} as const;

export type StoredSlotStyle<S extends CosmeticSlot = CosmeticSlot> = z.output<(typeof SLOT_SCHEMAS)[S]>;

export type SlotStyleResult = { ok: true; style: StoredSlotStyle } | { ok: false; error: string; path: string };

/**
 * Validates a slot's settings. Also accepts the resolved CosmeticStyle form wrapping it (e.g.
 * `{ glow: { ... } }` for profile_glow), as the website sends what it previews.
 */
export function parseSlotStyle(slot: CosmeticSlot, raw: unknown): SlotStyleResult {
  let value = raw;
  const key = SLOT_STYLE_KEY[slot];
  if (value && typeof value === "object" && !Array.isArray(value) && key in value && Object.keys(value).length === 1) {
    value = (value as Record<string, unknown>)[key];
  }
  const parsed = SLOT_SCHEMAS[slot].safeParse(value);
  if (parsed.success) return { ok: true, style: parsed.data as StoredSlotStyle };
  const issue = parsed.error.issues[0]!;
  const path = issue.path.join(".");
  return { ok: false, error: `${path ? `${path} ` : ""}${issue.message}`.trim(), path };
}

function assetUrl(id: string | null | undefined): string | null {
  return id ? `/api/store/assets/${id}` : null;
}

/** A stored slot style as its CosmeticStyle entry (e.g. `{ glow: {...} }`), asset ids as URLs. */
export function resolveSlotStyle(slot: CosmeticSlot, stored: StoredSlotStyle): CosmeticStyle {
  const value = { ...(stored as Record<string, unknown>) };
  for (const [idKey, urlKey] of [
    ["imageAssetId", "imageUrl"],
    ["rankStillAssetId", "rankStillUrl"],
    ["profileStillAssetId", "profileStillUrl"],
  ] as const) {
    if (idKey in value) {
      value[urlKey] = assetUrl(value[idKey] as string | null);
      delete value[idKey];
    }
  }
  for (const [idsKey, urlsKey] of [
    ["rankFramesAssetIds", "rankFramesUrls"],
    ["profileFramesAssetIds", "profileFramesUrls"],
  ] as const) {
    if (idsKey in value) {
      const ids = Array.isArray(value[idsKey]) ? (value[idsKey] as string[]) : [];
      value[urlsKey] = ids.map((id) => assetUrl(id)!);
      delete value[idsKey];
    }
  }
  return { [SLOT_STYLE_KEY[slot]]: value } as CosmeticStyle;
}
