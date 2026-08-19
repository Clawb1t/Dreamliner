import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { User } from "discord.js";
import { cardFont } from "../../welcome_message/functions/cardFonts.js";
import { canvasToGif } from "./gifEncode.js";

export const QUOTE_CARD_WIDTH = 1200;
export const QUOTE_CARD_HEIGHT = 500;
export const QUOTE_CARD_FILENAME = "quote.gif";

const AVATAR_PANEL_RATIO = 0.45;

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = words[0]!;

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]!;
    const test = `${current} ${word}`;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

function fitQuoteLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
): { lines: string[]; fontSize: number; lineHeight: number } {
  for (let fontSize = 48; fontSize >= 24; fontSize -= 2) {
    ctx.font = cardFont(600, fontSize);
    const lineHeight = Math.round(fontSize * 1.25);
    const lines = wrapText(ctx, text, maxWidth);
    const totalHeight = lines.length * lineHeight;
    if (totalHeight <= maxHeight) {
      return { lines, fontSize, lineHeight };
    }
  }

  ctx.font = cardFont(600, 24);
  const lineHeight = 30;
  const lines = wrapText(ctx, text, maxWidth);
  return { lines, fontSize: 24, lineHeight };
}

async function drawAvatarPanel(ctx: SKRSContext2D, user: User): Promise<void> {
  const panelWidth = Math.round(QUOTE_CARD_WIDTH * AVATAR_PANEL_RATIO);
  const url = user.displayAvatarURL({ size: 1024, extension: "png", forceStatic: true });

  let avatar: Awaited<ReturnType<typeof loadImage>> | null = null;
  try {
    avatar = await loadImage(url);
  } catch {
    avatar = null;
  }

  if (!avatar) return;

  const layer = createCanvas(panelWidth, QUOTE_CARD_HEIGHT);
  const g = layer.getContext("2d");

  const scale = Math.max(panelWidth / avatar.width, QUOTE_CARD_HEIGHT / avatar.height);
  const drawW = avatar.width * scale;
  const drawH = avatar.height * scale;
  const drawX = (panelWidth - drawW) / 2;
  const drawY = (QUOTE_CARD_HEIGHT - drawH) / 2;

  g.filter = "grayscale(100%)";
  g.drawImage(avatar, drawX, drawY, drawW, drawH);
  g.filter = "none";

  const gradient = g.createLinearGradient(panelWidth * 0.32, 0, panelWidth, 0);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.35, "rgba(0,0,0,0.18)");
  gradient.addColorStop(0.58, "rgba(0,0,0,0.48)");
  gradient.addColorStop(0.78, "rgba(0,0,0,0.78)");
  gradient.addColorStop(1, "rgba(0,0,0,1)");
  g.fillStyle = gradient;
  g.fillRect(0, 0, panelWidth, QUOTE_CARD_HEIGHT);

  ctx.drawImage(layer, 0, 0);
}

export async function renderQuoteCard(user: User, quoteText: string): Promise<Buffer> {
  const canvas = createCanvas(QUOTE_CARD_WIDTH, QUOTE_CARD_HEIGHT);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, QUOTE_CARD_WIDTH, QUOTE_CARD_HEIGHT);

  await drawAvatarPanel(ctx, user);

  const textPad = 40;
  const textLeft = Math.round(QUOTE_CARD_WIDTH * AVATAR_PANEL_RATIO) + textPad;
  const textWidth = QUOTE_CARD_WIDTH - textLeft - textPad;
  const textCenterX = textLeft + textWidth / 2;

  const nameSize = 28;
  const handleSize = 22;
  const nameLineHeight = 34;
  const handleLineHeight = 28;
  const attributionHeight = nameLineHeight + handleLineHeight + 20;

  const maxQuoteHeight = QUOTE_CARD_HEIGHT - attributionHeight - 56;
  const { lines, fontSize, lineHeight } = fitQuoteLines(ctx, quoteText, textWidth, maxQuoteHeight);
  const quoteHeight = lines.length * lineHeight;
  const blockHeight = quoteHeight + attributionHeight;
  let y = (QUOTE_CARD_HEIGHT - blockHeight) / 2;

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = cardFont(600, fontSize);
  for (const line of lines) {
    ctx.fillText(line, textCenterX, y);
    y += lineHeight;
  }

  y += 20;
  ctx.font = `italic ${cardFont(400, nameSize)}`;
  ctx.fillText(`- ${user.displayName}`, textCenterX, y);
  y += nameLineHeight;

  ctx.font = cardFont(400, handleSize);
  ctx.fillText(`@${user.username}`, textCenterX, y);

  return canvasToGif(canvas);
}
