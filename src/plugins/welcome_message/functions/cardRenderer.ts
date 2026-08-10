import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { Guild, GuildMember, User } from "discord.js";
import type { WelcomeCardConfig } from "../../../config/schemas/welcome.js";
import { renderTemplate } from "../../../core/templates.js";
import { readWelcomeAsset } from "./assets.js";
import { cardFont } from "./cardFonts.js";

export const WELCOME_CARD_WIDTH = 1000;
export const WELCOME_CARD_HEIGHT = 350;
export const WELCOME_CARD_FILENAME = "welcome.png";

export type CardRenderContext = {
  guildId: string;
  member?: GuildMember | null;
  user?: User | null;
  guild?: Guild | null;
};

function colorCss(n: number | undefined, fallback: number): string {
  const value = Number.isFinite(n) ? Math.max(0, Math.min(0xffffff, Math.floor(n!))) : fallback;
  return `#${value.toString(16).padStart(6, "0")}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function avatarRect(
  layout: WelcomeCardConfig["avatar_layout"],
  size: number,
): { x: number; y: number } {
  const pad = 48;
  const y = Math.round((WELCOME_CARD_HEIGHT - size) / 2);
  if (layout === "center") {
    return { x: Math.round((WELCOME_CARD_WIDTH - size) / 2), y };
  }
  if (layout === "right") {
    return { x: WELCOME_CARD_WIDTH - pad - size, y };
  }
  return { x: pad, y };
}

function textAnchor(
  card: WelcomeCardConfig,
  avatar: { x: number; y: number; size: number },
): { x: number; y: number; align: "left" | "center" | "right"; maxWidth: number } {
  const pad = 48;
  const gap = 28;

  if (card.text_layout === "below") {
    return {
      x: WELCOME_CARD_WIDTH / 2,
      y: avatar.y + avatar.size + 28,
      align: "center",
      maxWidth: WELCOME_CARD_WIDTH - pad * 2,
    };
  }

  if (card.text_layout === "overlay_center") {
    return {
      x: WELCOME_CARD_WIDTH / 2,
      y: WELCOME_CARD_HEIGHT / 2 - 8,
      align: "center",
      maxWidth: WELCOME_CARD_WIDTH - pad * 2,
    };
  }

  if (card.text_layout === "overlay_bottom") {
    return {
      x: WELCOME_CARD_WIDTH / 2,
      y: WELCOME_CARD_HEIGHT - 78,
      align: "center",
      maxWidth: WELCOME_CARD_WIDTH - pad * 2,
    };
  }

  // beside
  if (card.avatar_layout === "right") {
    return {
      x: pad,
      y: WELCOME_CARD_HEIGHT / 2 - 10,
      align: "left",
      maxWidth: avatar.x - pad - gap,
    };
  }
  if (card.avatar_layout === "center") {
    return {
      x: WELCOME_CARD_WIDTH / 2,
      y: Math.min(avatar.y - 36, WELCOME_CARD_HEIGHT / 2 - 40),
      align: "center",
      maxWidth: WELCOME_CARD_WIDTH - pad * 2,
    };
  }
  const left = avatar.x + avatar.size + gap;
  return {
    x: left,
    y: WELCOME_CARD_HEIGHT / 2 - 10,
    align: "left",
    maxWidth: WELCOME_CARD_WIDTH - left - pad,
  };
}

async function loadBackground(
  card: WelcomeCardConfig,
  guildId: string,
): Promise<{ kind: "image"; image: Awaited<ReturnType<typeof loadImage>> } | { kind: "color"; color: string }> {
  if (card.background_type === "asset" && card.background_asset_id) {
    const buf = readWelcomeAsset(guildId, card.background_asset_id);
    if (buf) {
      try {
        return { kind: "image", image: await loadImage(buf) };
      } catch {
        // fall through
      }
    }
  }
  if (card.background_type === "url" && card.background_url.trim()) {
    try {
      return { kind: "image", image: await loadImage(card.background_url.trim()) };
    } catch {
      // fall through
    }
  }
  return { kind: "color", color: colorCss(card.background_color, 0x1e1f22) };
}

async function loadAvatarImage(ctx: CardRenderContext): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
  const user = ctx.member?.user ?? ctx.user;
  if (!user) return null;
  const url = user.displayAvatarURL({ size: 256, extension: "png", forceStatic: true });
  try {
    return await loadImage(url);
  } catch {
    return null;
  }
}

export async function renderWelcomeCard(
  card: WelcomeCardConfig,
  ctx: CardRenderContext,
): Promise<Buffer> {
  const canvas = createCanvas(WELCOME_CARD_WIDTH, WELCOME_CARD_HEIGHT);
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, WELCOME_CARD_WIDTH, WELCOME_CARD_HEIGHT);

  const radius = clamp(card.border_radius ?? 24, 0, 80);
  const borderWidth = clamp(card.border_width ?? 0, 0, 32);
  const inset = borderWidth / 2;

  g.save();
  roundRect(g, 0, 0, WELCOME_CARD_WIDTH, WELCOME_CARD_HEIGHT, radius);
  g.clip();

  const background = await loadBackground(card, ctx.guildId);
  if (background.kind === "color") {
    g.fillStyle = background.color;
    g.fillRect(0, 0, WELCOME_CARD_WIDTH, WELCOME_CARD_HEIGHT);
  } else {
    const img = background.image;
    const scale = Math.max(WELCOME_CARD_WIDTH / img.width, WELCOME_CARD_HEIGHT / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    g.drawImage(img, (WELCOME_CARD_WIDTH - w) / 2, (WELCOME_CARD_HEIGHT - h) / 2, w, h);
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(0, 0, WELCOME_CARD_WIDTH, WELCOME_CARD_HEIGHT);
  }

  const accent = colorCss(card.accent_color, 0x5662f5);
  if (card.show_accent_bar !== false) {
    g.fillStyle = accent;
    g.fillRect(0, 0, 10, WELCOME_CARD_HEIGHT);
  }

  const avatarSize = clamp(
    card.avatar_size ?? (card.text_layout === "below" ? 140 : 180),
    64,
    240,
  );
  const baseAvatar = avatarRect(card.avatar_layout, avatarSize);
  const avatarPos = {
    x: baseAvatar.x + (card.avatar_offset_x ?? 0),
    y: baseAvatar.y + (card.avatar_offset_y ?? 0),
  };

  if (card.show_avatar) {
    const avatar = await loadAvatarImage(ctx);
    const corner = card.avatar_style === "circle" ? avatarSize / 2 : Math.round(avatarSize * 0.16);
    g.save();
    if (card.avatar_style === "circle") {
      g.beginPath();
      g.arc(
        avatarPos.x + avatarSize / 2,
        avatarPos.y + avatarSize / 2,
        avatarSize / 2,
        0,
        Math.PI * 2,
      );
      g.closePath();
      g.clip();
    } else {
      roundRect(g, avatarPos.x, avatarPos.y, avatarSize, avatarSize, corner);
      g.clip();
    }
    if (avatar) {
      g.drawImage(avatar, avatarPos.x, avatarPos.y, avatarSize, avatarSize);
    } else {
      g.fillStyle = "#2b2d31";
      g.fillRect(avatarPos.x, avatarPos.y, avatarSize, avatarSize);
    }
    g.restore();

    const ring = clamp(card.avatar_ring_width ?? 6, 0, 16);
    if (ring > 0) {
      g.strokeStyle = accent;
      g.lineWidth = ring;
      if (card.avatar_style === "circle") {
        g.beginPath();
        g.arc(
          avatarPos.x + avatarSize / 2,
          avatarPos.y + avatarSize / 2,
          avatarSize / 2 - ring / 2,
          0,
          Math.PI * 2,
        );
        g.stroke();
      } else {
        roundRect(
          g,
          avatarPos.x + ring / 2,
          avatarPos.y + ring / 2,
          avatarSize - ring,
          avatarSize - ring,
          Math.max(0, corner - ring / 2),
        );
        g.stroke();
      }
    }
  }

  const templateCtx = {
    member: ctx.member ?? null,
    user: ctx.user ?? ctx.member?.user ?? null,
    guild: ctx.guild ?? ctx.member?.guild ?? null,
  };
  const greeting = renderTemplate(card.greeting_text || "Welcome!", templateCtx);
  const subtitle = renderTemplate(card.subtitle_text || "", templateCtx);
  const textColor = colorCss(card.text_color, 0xffffff);
  const anchor = textAnchor(card, { ...avatarPos, size: avatarSize });
  const textX = anchor.x + (card.text_offset_x ?? 0);
  const textY = anchor.y + (card.text_offset_y ?? 0);
  const greetingSize = clamp(card.greeting_size ?? 44, 18, 72);
  const subtitleSize = clamp(card.subtitle_size ?? 24, 12, 48);

  g.fillStyle = textColor;
  g.textAlign = anchor.align;
  g.textBaseline = "middle";
  g.font = cardFont(700, greetingSize);
  const greetingY = subtitle ? textY - Math.round(subtitleSize * 0.75) : textY;
  g.fillText(greeting, textX, greetingY, Math.max(40, anchor.maxWidth));

  if (subtitle) {
    g.globalAlpha = 0.88;
    g.font = cardFont(500, subtitleSize);
    g.fillText(subtitle, textX, textY + Math.round(subtitleSize * 0.85), Math.max(40, anchor.maxWidth));
    g.globalAlpha = 1;
  }

  g.restore();

  if (borderWidth > 0) {
    g.strokeStyle = colorCss(card.border_color, 0x5662f5);
    g.lineWidth = borderWidth;
    roundRect(
      g,
      inset,
      inset,
      WELCOME_CARD_WIDTH - borderWidth,
      WELCOME_CARD_HEIGHT - borderWidth,
      Math.max(0, radius - inset),
    );
    g.stroke();
  }

  return canvas.toBuffer("image/png");
}
