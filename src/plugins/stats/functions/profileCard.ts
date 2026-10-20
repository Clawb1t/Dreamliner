import { loadImageSafe } from "../../../core/safeImage.js";
import { createCanvas, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { Client, User } from "discord.js";
import { siteFont } from "../../welcome_message/functions/cardFonts.js";
import { canvasGlyphSupport, cleanCanvasName, firstGrapheme, stripUnsupportedGlyphs, truncateToFit } from "../../../core/canvasText.js";
import { colorMix, ensureEmojiFont, loadImageMaybeDataUri, roundRect, tintedImage, type CardLayers, type CardMode } from "./charts.js";
import { getUserProfile } from "../../../bridge/userProfiles.js";
import { listDisplayedUserBadges } from "../../../bridge/userBadges.js";
import { getGlobalMessageStats } from "../../../bridge/userStats.js";
import { getProgressionBadges, loadBadgeImage } from "../../../core/progressionBadges/index.js";
import { getLogger } from "../../../core/logger.js";
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
  loadCosmeticImage,
  wholeImage,
  type ImageRegion,
} from "../../../core/cosmetics/canvas.js";

const log = getLogger("stats");

/**
 * The public profile page's hero card (website: ProfileBannerHero + the .lb-hero-* styles),
 * redrawn for /profile. Every size, color and spacing below mirrors the site's CSS at 1rem = 16px,
 * in the dark theme, then the whole card is drawn at 3x for a crisp image.
 */

const REM = 16;
const SITE = {
  surface: "#141417", // --surface (dark)
  surfaceMuted: "#1a1a21", // --surface-muted (dark)
  foreground: "#f4f4f5", // --foreground (dark)
  muted: "#9a9aa5", // --muted (dark)
  dashTrack: "#222229", // --dash-track (dark), badge chip base
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
  /** Progression badge art in display order; `tint` recolors single-color art (the One bolt). */
  progressionIcons: Array<{ image: Buffer; tint?: string; sizeRem: number }>;
  badges: ProfileCardBadge[];
  lastActiveAt: Date | null;
  now?: Date;
  /** Equipped store cosmetics (background, glow, frame, name font/colour, title, icon). */
  cosmetics?: CosmeticStyle | null;
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
export function dominantColor(image: Image, fallback = SITE.defaultAccent): string {
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

/** Single-color art (the One bolt) recolored, like the site's `color: var(--accent)` glyph. */
function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  return truncateToFit(text, (candidate) => ctx.measureText(candidate).width <= maxWidth);
}

export type ProfileCardOptions = { width?: number; scale?: number };

export async function renderProfileCard(source: ProfileCardData, options: ProfileCardOptions = {}): Promise<Buffer> {
  const result = await composeProfileCard(source, options, { kind: "png" });
  return result.canvas.toBuffer("image/png");
}

/** The /profile card as animation layers, its backdrop drawn from a background's frames
 *  (`firstFrame` stands in behind the frosted pills). */
export async function renderProfileCardLayers(source: ProfileCardData, options: ProfileCardOptions, firstFrame: ImageRegion): Promise<CardLayers> {
  const result = await composeProfileCard(source, options, { kind: "layers", firstFrame });
  return result.layers!;
}

async function composeProfileCard(
  source: ProfileCardData,
  options: ProfileCardOptions,
  mode: CardMode,
): Promise<{ canvas: Canvas; layers?: CardLayers }> {
  // Characters no font here can draw would show as "No Glyph" boxes: leave them out. (The probe
  // ignores the size in the font string, so any size works.)
  const cosmetics = source.cosmetics ?? {};
  const nameSize = 1.35 * REM;
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
  };
  const width = options.width ?? 760;
  const scale = options.scale ?? 3;
  const now = data.now ?? new Date();
  const accent = toHex(data.accent);
  const hasEmoji = ensureEmojiFont();

  // --- .lb-hero-* measurements ------------------------------------------------------------
  const padX = 1.25 * REM; // .lb-hero-identity / .lb-hero-tabs side padding
  const padBottom = 1.1 * REM;
  const spacer = 15 * REM; // .lb-hero-spacer
  const overlap = 3.5 * REM; // .lb-hero-identity margin-top: -3.5rem
  const avatarSize = 64;
  const avatarRadius = 1 * REM;
  const identityGap = 0.9 * REM;

  const nameLineHeight = nameSize * 1.25;
  const statsGap = 0.35 * REM; // .lb-hero-stats margin-top
  const pillFont = 0.78 * REM;
  const pillPadY = 0.2 * REM;
  const pillPadX = 0.6 * REM;
  const pillHeight = pillFont * 1.3 + pillPadY * 2;

  const chipFont = 0.75 * REM; // .badge-chip-sm
  const chipPadY = 0.22 * REM;
  const chipPadX = 0.5 * REM;
  const chipIcon = 1.1 * REM;
  const chipInnerGap = 0.4 * REM;
  const chipHeight = Math.max(chipIcon, chipFont * 1.3) + chipPadY * 2;
  const chipGap = 0.4 * REM; // .profile-hero-badges gap

  // Badge chips wrap onto more rows like the site's flex-wrap row.
  const measure = createCanvas(1, 1).getContext("2d");
  measure.font = siteFont(650, chipFont);
  const chips = data.badges.map((badge) => {
    const showIcon = Boolean(badge.iconImageUrl) || Boolean(badge.icon && hasEmoji) || !badge.icon;
    const textWidth = measure.measureText(badge.name).width;
    return { badge, showIcon, w: chipPadX * 2 + (showIcon ? chipIcon + chipInnerGap : 0) + textWidth };
  });
  const rows: (typeof chips)[] = [];
  let rowWidth = 0;
  for (const chip of chips) {
    const available = width - padX * 2;
    if (rows.length === 0 || rowWidth + chipGap + chip.w > available) {
      rows.push([chip]);
      rowWidth = chip.w;
    } else {
      rows[rows.length - 1]!.push(chip);
      rowWidth += chipGap + chip.w;
    }
  }
  const badgesHeight = rows.length > 0 ? rows.length * chipHeight + (rows.length - 1) * chipGap + padBottom : 0;
  const identityTop = spacer - overlap;
  const identityBottom = identityTop + avatarSize;
  const height = Math.round(identityBottom + padBottom + badgesHeight);

  const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
  const scaled = (target: Canvas) => {
    const c = target.getContext("2d");
    c.scale(scale, scale);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    return c;
  };

  const [avatar, banner, stillImage] = await Promise.all([
    data.avatarURL ? loadImageMaybeDataUri(data.avatarURL).catch(() => null) : Promise.resolve(null),
    data.bannerURL && mode.kind === "png"
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
  ]);
  const still = stillImage?.width && stillImage.height ? wholeImage(stillImage) : null;

  // --- Card + banner (.lb-hero-card / .lb-hero-banner / .lb-hero-scrim) --------------------
  const paintBackdrop = (target: SKRSContext2D, background: ImageRegion | null): boolean => {
    target.save();
    roundRect(target, 0, 0, width, height, 1.25 * REM);
    target.clip();
    const soft = colorMix(accent, 14, SITE.surface);
    const backdropGradient = target.createLinearGradient(0, 0, width, height);
    backdropGradient.addColorStop(0, soft);
    backdropGradient.addColorStop(1, SITE.surfaceMuted);
    target.fillStyle = backdropGradient;
    target.fillRect(0, 0, width, height);

    // An equipped background replaces the banner (or the blurred avatar standing in for one).
    // Without a still yet, the card keeps its normal backdrop.
    if (background) drawCoverRegion(target, background, { x: 0, y: 0, w: width, h: height });
    const themed = Boolean(background);
    const backdrop = themed ? null : (banner ?? avatar);
    if (backdrop) {
      const blurredFallback = !banner;
      const zoom = blurredFallback ? 1.15 : 1;
      const cover = Math.max(width / backdrop.width, height / backdrop.height) * zoom;
      const w = backdrop.width * cover;
      const h = backdrop.height * cover;
      target.save();
      // No banner: the avatar stands in, blurred and dimmed so it reads as a backdrop.
      // Canvas filters work in device pixels, so the site's 20px blur is scaled with the card.
      if (blurredFallback) target.filter = `blur(${20 * scale}px) saturate(1.15)`;
      target.drawImage(backdrop, (width - w) / 2, (height - h) / 2, w, h);
      target.restore();
      if (blurredFallback) {
        // brightness(0.75), as a black layer: the same result on every canvas build.
        target.fillStyle = "rgba(0, 0, 0, 0.25)";
        target.fillRect(0, 0, width, height);
      }
    }
    const scrim = target.createLinearGradient(0, 0, 0, height);
    scrim.addColorStop(0.55, "rgba(0, 0, 0, 0)");
    scrim.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    target.fillStyle = scrim;
    target.fillRect(0, 0, width, height);
    if (themed) {
      // Scenes can be bright where the name sits: shade the identity corner a little more.
      const cx = padX + avatarSize * 1.6;
      const cy = spacer - overlap + avatarSize / 2;
      const shade = target.createRadialGradient(cx, cy, 0, cx, cy, width * 0.42);
      shade.addColorStop(0, "rgba(0, 0, 0, 0.45)");
      shade.addColorStop(0.6, "rgba(0, 0, 0, 0.2)");
      shade.addColorStop(1, "rgba(0, 0, 0, 0)");
      target.fillStyle = shade;
      target.fillRect(0, 0, width, height);
    }
    if (cosmetics.glow) {
      drawGlow(target, cosmetics.glow, { x: 0, y: 0, w: width, h: height }, { x: padX + avatarSize / 2, y: spacer - overlap + avatarSize / 2 });
    }
    target.restore();
    return themed;
  };

  // Animated: the backdrop is painted per frame, everything else goes on a transparent overlay.
  const backdropCanvas = mode.kind === "layers" ? createCanvas(canvas.width, canvas.height) : canvas;
  const themed = paintBackdrop(scaled(backdropCanvas), mode.kind === "layers" ? mode.firstFrame : still);
  const ctx = mode.kind === "layers" ? scaled(canvas) : canvas.getContext("2d");

  // Frosted pills (backdrop-filter: blur(4px)) need a blurred copy of what's behind them.
  const frosted = createCanvas(canvas.width, canvas.height);
  const frostedCtx = frosted.getContext("2d");
  frostedCtx.filter = `blur(${4 * scale}px)`;
  frostedCtx.drawImage(backdropCanvas, 0, 0);

  // --- Avatar (.lb-hero-icon) ------------------------------------------------------------------
  const avatarX = padX;
  const avatarY = identityTop;
  ctx.save();
  roundRect(ctx, avatarX, avatarY, avatarSize, avatarSize, avatarRadius);
  ctx.clip();
  ctx.fillStyle = SITE.surfaceMuted;
  ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
  if (avatar) {
    const cover = Math.max(avatarSize / avatar.width, avatarSize / avatar.height);
    const w = avatar.width * cover;
    const h = avatar.height * cover;
    ctx.drawImage(avatar, avatarX + (avatarSize - w) / 2, avatarY + (avatarSize - h) / 2, w, h);
  } else {
    ctx.fillStyle = SITE.muted;
    ctx.font = siteFont(750, 1.5 * REM);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((firstGrapheme(data.displayName) ?? "?").toUpperCase(), avatarX + avatarSize / 2, avatarY + avatarSize / 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
  if (cosmetics.frame) {
    await drawAvatarFrame(ctx, cosmetics.frame, { x: avatarX, y: avatarY, size: avatarSize, radius: avatarRadius }, data.username).catch(
      (error: unknown) => log.warn(`[profile card] avatar frame failed to draw:`, error),
    );
  }

  // --- Name row (.lb-hero-name-row) + stat pills (.lb-hero-stats), bottom-aligned -------------
  const textX = avatarX + avatarSize + identityGap;
  const textRight = width - padX;
  const textBottom = identityBottom - 0.1 * REM; // .lb-hero-text padding-bottom
  const pillsTop = textBottom - pillHeight;
  // An equipped title gets its own small line between the name and the pills.
  const titleFont = siteFont(650, 0.8 * REM);
  const titleLine = cosmetics.title ? 0.8 * REM * 1.3 + 0.15 * REM : 0;
  const nameLineTop = pillsTop - statsGap - titleLine - nameLineHeight;
  const nameCenterY = nameLineTop + nameLineHeight / 2;

  const icons: Array<{ draw: Image | Canvas; size: number }> = [];
  for (const icon of data.progressionIcons) {
    try {
      const image = await loadImageSafe(icon.image);
      const size = icon.sizeRem * REM;
      icons.push({ draw: icon.tint ? tintedImage(image, icon.tint, Math.ceil(size * scale)) : image, size });
    } catch {
      // unreadable art: leave that one off
    }
  }
  const rowGap = 0.4 * REM; // .lb-hero-name-row gap
  const iconsGap = 0.3 * REM; // .progression-badges gap
  // The icons sit in a frosted pill, the same style as the "last seen" pill (.lb-hero-stat).
  const iconPillPadX = pillPadX;
  const iconPillPadY = pillPadY;
  const iconsWidth =
    icons.length > 0
      ? icons.reduce((sum, icon) => sum + icon.size, 0) + (icons.length - 1) * iconsGap + iconPillPadX * 2
      : 0;
  const iconPillHeight = Math.max(0, ...icons.map((icon) => icon.size)) + iconPillPadY * 2;

  // The name icon cosmetic sits right after the name.
  const nameIconSize = 1.05 * REM;
  const emojiFont = `${nameIconSize}px "Rank Card Emoji", "Segoe UI Emoji", sans-serif`;
  const emojiOk = (emoji: string) => hasEmoji && stripUnsupportedGlyphs(emoji, emojiGlyphs) === emoji;
  const hasNameIcon = Boolean(cosmetics.icon && (cosmetics.icon.imageUrl || (cosmetics.icon.emoji && emojiOk(cosmetics.icon.emoji))));
  const nameIconWidth = hasNameIcon ? rowGap + nameIconSize : 0;

  ctx.font = nameFont;
  const nameMax = textRight - textX - (icons.length > 0 ? rowGap + iconsWidth : 0) - nameIconWidth;
  const name = ellipsize(ctx, data.displayName, Math.max(40, nameMax));
  ctx.textBaseline = "middle";
  let nameEnd =
    textX +
    drawCosmeticName(ctx, name, textX, nameCenterY + 0.5, { font: nameFont, color: cosmetics.nameColor, defaultColor: "#ffffff", sizePx: nameSize, shadow: themed || Boolean(cosmetics.nameColor) });
  ctx.textBaseline = "alphabetic";
  if (hasNameIcon && cosmetics.icon) {
    const drawn = await drawNameIcon(ctx, cosmetics.icon, nameEnd + rowGap, nameCenterY, nameIconSize, { emojiFont, canDrawEmoji: emojiOk }).catch(() => 0);
    if (drawn > 0) nameEnd += rowGap + drawn;
  }
  if (cosmetics.title) {
    ctx.textBaseline = "middle";
    drawCosmeticTitle(ctx, cosmetics.title, textX, nameLineTop + nameLineHeight + titleLine / 2, titleFont, "rgba(255,255,255,0.8)", textRight - textX);
    ctx.textBaseline = "alphabetic";
  }

  if (icons.length > 0) {
    const pillX = nameEnd + rowGap;
    const pillTop = nameCenterY - iconPillHeight / 2;
    ctx.save();
    roundRect(ctx, pillX, pillTop, iconsWidth, iconPillHeight, 999);
    ctx.clip();
    ctx.drawImage(frosted, 0, 0, width, height);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(pillX, pillTop, iconsWidth, iconPillHeight);
    ctx.restore();
    let iconX = pillX + iconPillPadX;
    for (const icon of icons) {
      ctx.drawImage(icon.draw, iconX, nameCenterY - icon.size / 2, icon.size, icon.size);
      iconX += icon.size + iconsGap;
    }
  }

  const pills: Array<{ text: string; dot?: string }> = [{ text: `@${data.username}` }];
  const seen = lastSeenLabel(data.lastActiveAt, now);
  if (seen) pills.push({ text: seen.text, dot: seen.active ? SITE.online : SITE.muted });
  let pillX = textX;
  ctx.font = siteFont(650, pillFont);
  for (const pill of pills) {
    const dotPart = pill.dot ? 6 + 0.3 * REM : 0;
    const pillWidth = pillPadX * 2 + dotPart + ctx.measureText(pill.text).width;
    if (pillX + pillWidth > textRight) break;
    ctx.save();
    roundRect(ctx, pillX, pillsTop, pillWidth, pillHeight, 999);
    ctx.clip();
    ctx.drawImage(frosted, 0, 0, width, height);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(pillX, pillsTop, pillWidth, pillHeight);
    ctx.restore();

    let cursor = pillX + pillPadX;
    const centerY = pillsTop + pillHeight / 2;
    if (pill.dot) {
      ctx.fillStyle = pill.dot;
      ctx.beginPath();
      ctx.arc(cursor + 3, centerY, 3, 0, Math.PI * 2);
      ctx.fill();
      cursor += dotPart;
    }
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(pill.text, cursor, centerY + 0.5);
    ctx.textBaseline = "alphabetic";
    pillX += pillWidth + 0.5 * REM;
  }

  // --- Profile badges (.profile-hero-badges, BadgeChip size="sm") ------------------------------
  let rowTop = identityBottom + padBottom;
  for (const row of rows) {
    let chipX = padX;
    for (const chip of row) {
      const color = chip.badge.colorHex || accent;
      ctx.fillStyle = colorMix(toHex(color), 14, SITE.dashTrack);
      roundRect(ctx, chipX, rowTop, chip.w, chipHeight, 12);
      ctx.fill();

      let cursor = chipX + chipPadX;
      const centerY = rowTop + chipHeight / 2;
      if (chip.showIcon) {
        if (chip.badge.iconImageUrl) {
          try {
            const icon = await loadImageMaybeDataUri(chip.badge.iconImageUrl);
            ctx.save();
            ctx.beginPath();
            ctx.arc(cursor + chipIcon / 2, centerY, chipIcon / 2, 0, Math.PI * 2);
            ctx.clip();
            const cover = Math.max(chipIcon / icon.width, chipIcon / icon.height);
            ctx.drawImage(icon, cursor + (chipIcon - icon.width * cover) / 2, centerY - (icon.height * cover) / 2, icon.width * cover, icon.height * cover);
            ctx.restore();
          } catch {
            // icon slot stays blank, like a broken image on the site
          }
        } else {
          ctx.fillStyle = SITE.foreground;
          ctx.font = chip.badge.icon ? `${0.8 * REM}px "Rank Card Emoji", "Segoe UI Emoji", sans-serif` : siteFont(650, 0.8 * REM);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(chip.badge.icon || firstGrapheme(chip.badge.name) || "", cursor + chipIcon / 2, centerY + 0.5);
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
        }
        cursor += chipIcon + chipInnerGap;
      }
      ctx.fillStyle = SITE.foreground;
      ctx.font = siteFont(650, chipFont);
      ctx.textBaseline = "middle";
      ctx.fillText(chip.badge.name, cursor, centerY + 0.5);
      ctx.textBaseline = "alphabetic";
      chipX += chip.w + chipGap;
    }
    rowTop += chipHeight + chipGap;
  }

  if (mode.kind === "png") return { canvas };
  return { canvas, layers: { width, height, scale, overlay: canvas, paintBackdrop: (target, frame) => void paintBackdrop(target, frame) } };
}

export type ProfileStatsSummary = {
  totalMessages: number;
  serverCount: number;
  /** Null when they have no tracked messages yet. */
  globalRank: number | null;
};

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
  const fetched = await client.users.fetch(user.id, { force: true }).catch(() => user);
  const displayName = fetched.globalName ?? fetched.username;
  const [profile, badges, progression, stats] = await Promise.all([
    getUserProfile(user.id),
    listDisplayedUserBadges(user.id),
    getProgressionBadges(client, user.id).catch(() => []),
    getGlobalMessageStats(user.id).catch(() => null),
  ]);
  // Same rule as the site: a private profile is only visible to its owner.
  if (!profile.profileVisible && viewerId !== user.id) return { ok: false, reason: "private", displayName };

  const avatarURL = fetched.displayAvatarURL({ size: 512, extension: "png" });
  let accent = profile.accentColor;
  if (!accent) {
    const avatar = await loadImageMaybeDataUri(fetched.displayAvatarURL({ size: 128, extension: "png" })).catch(() => null);
    accent = avatar ? dominantColor(avatar) : SITE.defaultAccent;
  }

  const progressionIcons: ProfileCardData["progressionIcons"] = [];
  for (const badge of progression) {
    const art = await loadBadgeImage(badge.imageKey).catch(() => null);
    if (!art) continue;
    // The site draws Dreamliner One as its own bolt glyph (0.8rem, accent colored) and every
    // other badge as its art at 13.2px (.lb-hero-name-row .progression-badge-img).
    progressionIcons.push(
      badge.id === "dreamliner_one"
        ? { image: art.buffer, tint: toHex(accent), sizeRem: 0.8 }
        : { image: art.buffer, sizeRem: 13.2 / REM },
    );
  }

  const cardData: ProfileCardData = {
    displayName,
    username: fetched.username,
    avatarURL,
    bannerURL: fetched.bannerURL({ size: 2048, extension: "png" }) ?? null,
    accent,
    progressionIcons,
    badges: badges.map((badge) => ({
      name: badge.name,
      icon: badge.icon,
      iconImageUrl: badge.iconImageUrl,
      colorHex: badge.colorHex,
    })),
    lastActiveAt: stats?.lastActiveAt ?? null,
    cosmetics: (() => {
      try {
        return getEquippedStyle(user.id);
      } catch {
        return null;
      }
    })(),
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
    stats: {
      totalMessages: stats?.totalMessages ?? 0,
      serverCount: stats?.serverCount ?? 0,
      globalRank: stats?.globalRank ?? null,
    },
  };
}

