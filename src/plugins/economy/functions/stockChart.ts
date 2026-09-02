import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { StockCandle } from "./stocks.js";

// Candlestick chart image for /stock view — same palette as the other bot-rendered
// charts (src/plugins/stats/functions/charts.ts) and the same up/down colors as the
// website's exchange pages, so a chart looks the same whether it's opened in Discord
// or on the site.

const FONT = "Segoe UI";

const COLORS = {
  bg: "#2b2d31",
  grid: "rgba(255,255,255,0.07)",
  text: "#b5bac1",
  muted: "#80848e",
  up: "#059669",
  down: "#dc2626",
};

function font(weight: "" | "600", size: number): string {
  return weight ? `${weight} ${size}px "${FONT}", Arial, sans-serif` : `${size}px "${FONT}", Arial, sans-serif`;
}

function niceStep(range: number, ticks = 4): number {
  if (range <= 0) return 1;
  const rough = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export type StockChartOptions = {
  candles: StockCandle[];
  width?: number;
  scale?: number;
};

/** Renders a dark-themed candlestick chart as a PNG buffer suitable for a Discord attachment. */
export async function renderStockChart(options: StockChartOptions): Promise<Buffer> {
  const width = options.width ?? 900;
  const scale = options.scale ?? 2;

  const padTop = 16;
  const padBottom = 24;
  const padRight = 62;
  const padLeft = 8;
  const priceH = 340;
  const height = padTop + priceH + padBottom;

  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const candles = options.candles;
  if (candles.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = font("", 16);
    ctx.fillText("No price history yet.", padLeft + 12, height / 2);
    return canvas.toBuffer("image/png");
  }

  const plotW = width - padLeft - padRight;
  const slot = plotW / candles.length;
  const xFor = (i: number) => padLeft + i * slot + slot / 2;

  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  const cushion = (hi - lo) * 0.1 || hi * 0.02 || 1;
  const min = lo - cushion;
  const max = hi + cushion;
  const span = max - min || 1;
  const yFor = (v: number) => padTop + (1 - (v - min) / span) * priceH;

  const step = niceStep(max - min);
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.muted;
  ctx.font = font("", 12);
  ctx.lineWidth = 1;
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.fillText(`$${v >= 1000 ? v.toFixed(0) : v.toFixed(2)}`, width - padRight + 8, y + 4);
  }

  const bodyW = Math.max(2, slot * 0.55);
  for (const [i, c] of candles.entries()) {
    const x = xFor(i);
    const up = c.close >= c.open;
    const color = up ? COLORS.up : COLORS.down;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, yFor(c.high));
    ctx.lineTo(x, yFor(c.low));
    ctx.stroke();
    const bodyTop = yFor(Math.max(c.open, c.close));
    const bodyBottom = yFor(Math.min(c.open, c.close));
    roundRect(ctx, x - bodyW / 2, bodyTop, bodyW, Math.max(1, bodyBottom - bodyTop), 1);
    ctx.fill();
  }

  const first = candles[0]!.open;
  const last = candles[candles.length - 1]!.close;
  const overallUp = last >= first;
  ctx.strokeStyle = overallUp ? COLORS.up : COLORS.down;
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padLeft, yFor(last));
  ctx.lineTo(width - padRight, yFor(last));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.fillStyle = COLORS.muted;
  ctx.font = font("", 11);
  ctx.textAlign = "left";
  ctx.fillText(formatTime(candles[0]!.startTime), padLeft, height - 6);
  ctx.textAlign = "right";
  ctx.fillText(formatTime(candles[candles.length - 1]!.endTime), width - padRight, height - 6);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}
