import { DREAMLINER_ACCENT_HEX } from "../../../core/embeds.js";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

export type ChartSeries = {
  label: string;
  color: string;
  values: number[];
};

export type ActivityChartOptions = {
  title?: string;
  subtitle?: string;
  labels: string[];
  series: ChartSeries[];
  mode?: "line" | "bar";
  width?: number;
  height?: number;
  scale?: number;
};

const FONT = "Segoe UI";

const COLORS = {
  bg: "#2b2d31",
  grid: "rgba(255,255,255,0.06)",
  text: "#b5bac1",
  muted: "#80848e",
};

function font(weight: "" | "600" | "500", size: number): string {
  return weight ? `${weight} ${size}px "${FONT}", Arial, sans-serif` : `${size}px "${FONT}", Arial, sans-serif`;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const padded = value * 1.1;
  const magnitude = 10 ** Math.floor(Math.log10(padded));
  const normalized = padded / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function formatTick(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export async function renderActivityChart(options: ActivityChartOptions): Promise<Buffer> {
  const width = options.width ?? 1100;
  const height = options.height ?? 420;
  const scale = options.scale ?? 2;
  const mode = options.mode ?? (options.series.length === 1 ? "bar" : "line");
  const showLegend = options.series.length > 1;

  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Minimal: chart only — embed carries the title.
  const pad = {
    top: 28,
    right: 24,
    bottom: showLegend ? 64 : 44,
    left: 52,
  };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const allValues = options.series.flatMap((s) => s.values);
  const maxValue = niceMax(Math.max(0, ...allValues));
  const pointCount = Math.max(1, options.labels.length);

  // Soft horizontal guides only
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.muted;
  ctx.font = font("", 13);
  ctx.lineWidth = 1;
  const tickCount = 3;
  for (let i = 0; i <= tickCount; i++) {
    const ratio = i / tickCount;
    const y = pad.top + plotH - ratio * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    const label = formatTick(maxValue * ratio);
    const metrics = ctx.measureText(label);
    ctx.fillText(label, pad.left - 10 - metrics.width, y + 4);
  }

  if (mode === "bar" && options.series[0]) {
    drawBars(ctx, options.series[0], pad, plotW, plotH, maxValue, pointCount);
  } else {
    for (const series of options.series) {
      drawLine(ctx, series, pad, plotW, plotH, maxValue, pointCount);
    }
  }

  // Sparse x labels
  ctx.fillStyle = COLORS.muted;
  ctx.font = font("", 13);
  const labelStep = Math.max(1, Math.ceil(pointCount / 8));
  for (let i = 0; i < pointCount; i++) {
    if (i % labelStep !== 0 && i !== pointCount - 1) continue;
    const x = pad.left + (pointCount === 1 ? plotW / 2 : (i / (pointCount - 1)) * plotW);
    const label = options.labels[i] ?? "";
    const metrics = ctx.measureText(label);
    ctx.fillText(label, x - metrics.width / 2, pad.top + plotH + 22);
  }

  if (showLegend) {
    let legendX = pad.left;
    const legendY = height - 22;
    ctx.font = font("", 13);
    for (const series of options.series) {
      ctx.fillStyle = series.color;
      ctx.beginPath();
      ctx.arc(legendX + 4, legendY - 4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(series.label, legendX + 14, legendY);
      legendX += 22 + ctx.measureText(series.label).width + 18;
    }
  }

  return canvas.toBuffer("image/png");
}

function drawLine(
  ctx: SKRSContext2D,
  series: ChartSeries,
  pad: { top: number; right: number; bottom: number; left: number },
  plotW: number,
  plotH: number,
  maxValue: number,
  pointCount: number,
) {
  if (series.values.length === 0) return;

  const points = series.values.map((value, i) => {
    const x = pad.left + (pointCount === 1 ? plotW / 2 : (i / (pointCount - 1)) * plotW);
    const y = pad.top + plotH - (value / maxValue) * plotH;
    return { x, y };
  });

  ctx.beginPath();
  ctx.strokeStyle = series.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  points.forEach((point, i) => {
    if (i === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  // Tiny endpoints only — keeps the line clean
  for (const point of points) {
    ctx.beginPath();
    ctx.fillStyle = series.color;
    ctx.arc(point.x, point.y, 2.25, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBars(
  ctx: SKRSContext2D,
  series: ChartSeries,
  pad: { top: number; right: number; bottom: number; left: number },
  plotW: number,
  plotH: number,
  maxValue: number,
  pointCount: number,
) {
  const gap = pointCount > 20 ? 2 : 6;
  const slot = plotW / pointCount;
  const barWidth = Math.max(4, slot - gap);

  series.values.forEach((value, i) => {
    const x = pad.left + i * slot + (slot - barWidth) / 2;
    const h = (value / maxValue) * plotH;
    const y = pad.top + plotH - h;
    ctx.fillStyle = series.color;
    roundRect(ctx, x, y, barWidth, Math.max(h, value > 0 ? 2 : 0), 3);
    ctx.fill();
  });
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

export type PieSegment = {
  label: string;
  value: number;
  color: string;
};

export async function renderWeekdayChart(
  labels: string[],
  values: number[],
  color = "#5865F2",
): Promise<Buffer> {
  return renderActivityChart({
    labels,
    series: [{ label: "Activity", color, values }],
    mode: "bar",
  });
}

export async function renderPieChart(segments: PieSegment[]): Promise<Buffer> {
  const width = 1100;
  const height = 420;
  const scale = 2;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const cx = width * 0.36;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.28;
  let start = -Math.PI / 2;

  if (total <= 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = font("", 16);
    ctx.fillText("No data in this window", cx - 70, cy);
    return canvas.toBuffer("image/png");
  }

  for (const segment of segments) {
    if (segment.value <= 0) continue;
    const slice = (segment.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.fillStyle = segment.color;
    ctx.arc(cx, cy, radius, start, start + slice);
    ctx.closePath();
    ctx.fill();
    start += slice;
  }

  ctx.beginPath();
  ctx.fillStyle = COLORS.bg;
  ctx.arc(cx, cy, radius * 0.52, 0, Math.PI * 2);
  ctx.fill();

  let legendY = 72;
  const legendX = width * 0.62;
  ctx.font = font("", 14);
  for (const segment of segments) {
    const pct = total > 0 ? ((segment.value / total) * 100).toFixed(1) : "0.0";
    ctx.fillStyle = segment.color;
    ctx.fillRect(legendX, legendY - 10, 12, 12);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${segment.label} · ${formatTick(segment.value)} (${pct}%)`, legendX + 20, legendY);
    legendY += 28;
  }

  return canvas.toBuffer("image/png");
}

export async function renderHorizontalBarChart(
  labels: string[],
  values: number[],
  color = "#5865F2",
): Promise<Buffer> {
  const width = 1100;
  const height = 420;
  const scale = 2;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const pad = { top: 24, right: 24, bottom: 24, left: 140 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const count = Math.max(1, labels.length);
  const maxValue = niceMax(Math.max(0, ...values));
  const rowH = plotH / count;

  ctx.font = font("", 13);
  labels.forEach((label, i) => {
    const value = values[i] ?? 0;
    const y = pad.top + i * rowH + rowH / 2;
    const barW = (value / maxValue) * plotW;
    const barH = Math.max(8, rowH - 12);

    ctx.fillStyle = COLORS.muted;
    const trimmed = label.length > 16 ? `${label.slice(0, 15)}…` : label;
    ctx.fillText(trimmed, pad.left - 12 - ctx.measureText(trimmed).width, y + 4);

    ctx.fillStyle = "rgba(255,255,255,0.05)";
    roundRect(ctx, pad.left, y - barH / 2, plotW, barH, 4);
    ctx.fill();

    if (value > 0) {
      ctx.fillStyle = color;
      roundRect(ctx, pad.left, y - barH / 2, Math.max(barW, 4), barH, 4);
      ctx.fill();
    }

    ctx.fillStyle = COLORS.text;
    ctx.fillText(formatTick(value), pad.left + barW + 8, y + 4);
  });

  return canvas.toBuffer("image/png");
}

export async function renderStackedBarChart(
  labels: string[],
  series: ChartSeries[],
): Promise<Buffer> {
  const width = 1100;
  const height = 420;
  const scale = 2;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const pad = { top: 28, right: 24, bottom: 64, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const pointCount = Math.max(1, labels.length);
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const maxValue = niceMax(Math.max(0, ...totals));
  const gap = pointCount > 20 ? 2 : 6;
  const slot = plotW / pointCount;
  const barWidth = Math.max(4, slot - gap);

  labels.forEach((_, i) => {
    let yBase = pad.top + plotH;
    series.forEach((entry) => {
      const value = entry.values[i] ?? 0;
      const h = (value / maxValue) * plotH;
      yBase -= h;
      if (value <= 0) return;
      ctx.fillStyle = entry.color;
      roundRect(ctx, pad.left + i * slot + (slot - barWidth) / 2, yBase, barWidth, Math.max(h, 2), 2);
      ctx.fill();
    });
  });

  ctx.fillStyle = COLORS.muted;
  ctx.font = font("", 13);
  const labelStep = Math.max(1, Math.ceil(pointCount / 8));
  for (let i = 0; i < pointCount; i++) {
    if (i % labelStep !== 0 && i !== pointCount - 1) continue;
    const x = pad.left + (pointCount === 1 ? plotW / 2 : (i / (pointCount - 1)) * plotW);
    const label = labels[i] ?? "";
    ctx.fillText(label, x - ctx.measureText(label).width / 2, pad.top + plotH + 22);
  }

  let legendX = pad.left;
  const legendY = height - 22;
  for (const entry of series) {
    ctx.fillStyle = entry.color;
    ctx.fillRect(legendX, legendY - 10, 10, 10);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(entry.label, legendX + 14, legendY);
    legendX += 24 + ctx.measureText(entry.label).width + 12;
  }

  return canvas.toBuffer("image/png");
}

export type LeaderboardRow = {
  rank: number;
  label: string;
  count: number;
  shareLabel: string;
  sharePct: number;
  avatarURL?: string | null;
  fallbackInitial?: string;
};

export type LeaderboardImageOptions = {
  title: string;
  subtitle?: string;
  rows: LeaderboardRow[];
  accentColor?: string;
  width?: number;
  scale?: number;
};

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function drawCircleAvatar(
  ctx: SKRSContext2D,
  image: import("@napi-rs/canvas").Image,
  x: number,
  y: number,
  size: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(image, x, y, size, size);
  ctx.restore();
}

function drawInitialAvatar(ctx: SKRSContext2D, initial: string, x: number, y: number, size: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = font("600", Math.floor(size * 0.42));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initial, x + size / 2, y + size / 2 + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rankAccentOpacity(rank: number): number {
  if (rank === 1) return 1;
  if (rank === 2) return 0.82;
  if (rank === 3) return 0.66;
  return 0.48;
}

export async function renderLeaderboardImage(options: LeaderboardImageOptions): Promise<Buffer> {
  const width = options.width ?? 1100;
  const scale = options.scale ?? 2;
  const accent = options.accentColor ?? DREAMLINER_ACCENT_HEX;
  const padX = 40;
  const rowInnerPad = 20;
  const headerHeight = 104;
  const rowHeight = 82;
  const rowGap = 12;
  const rankSize = 36;
  const avatarSize = 46;
  const shareColWidth = 136;
  const rows = options.rows.slice(0, 10);
  const bodyHeight = rows.length > 0 ? rows.length * rowHeight + (rows.length - 1) * rowGap : 48;
  const height = headerHeight + 28 + bodyHeight + 28;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#f2f3f5";
  ctx.font = font("600", 30);
  ctx.fillText(options.title, padX, 46);
  if (options.subtitle) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = font("", 15);
    ctx.fillText(options.subtitle, padX, 74);
  }

  if (rows.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = font("", 18);
    ctx.fillText("No activity recorded in this window yet.", padX, headerHeight + 36);
    return canvas.toBuffer("image/png");
  }

  const rowLeft = padX;
  const rowWidth = width - padX * 2;
  const contentRight = rowLeft + rowWidth - rowInnerPad;
  const shareColX = contentRight - shareColWidth;
  const maxShare = Math.max(...rows.map((row) => row.sharePct), 1);
  let y = headerHeight + 28;

  for (const row of rows) {
    const rowTop = y;
    const rowCenter = rowTop + rowHeight / 2;

    ctx.fillStyle = "rgba(255,255,255,0.035)";
    roundRect(ctx, rowLeft, rowTop, rowWidth, rowHeight, 12);
    ctx.fill();

    const rankX = rowLeft + rowInnerPad;
    ctx.fillStyle = hexToRgba(accent, rankAccentOpacity(row.rank));
    ctx.beginPath();
    ctx.arc(rankX + rankSize / 2, rowCenter, rankSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = font("600", 16);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(row.rank), rankX + rankSize / 2, rowCenter);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    const avatarX = rankX + rankSize + 18;
    const avatarY = rowCenter - avatarSize / 2;
    if (row.avatarURL) {
      try {
        const image = await loadImage(row.avatarURL);
        drawCircleAvatar(ctx, image, avatarX, avatarY, avatarSize);
      } catch {
        drawInitialAvatar(ctx, row.fallbackInitial ?? row.label.charAt(0), avatarX, avatarY, avatarSize, accent);
      }
    } else {
      drawInitialAvatar(ctx, row.fallbackInitial ?? row.label.charAt(0), avatarX, avatarY, avatarSize, accent);
    }

    const textX = avatarX + avatarSize + 18;
    const textMaxWidth = shareColX - textX - 24;
    let label = row.label;
    ctx.fillStyle = "#f2f3f5";
    ctx.font = font("600", 19);
    while (label.length > 1 && ctx.measureText(label).width > textMaxWidth) {
      label = `${label.slice(0, -2)}…`;
    }
    ctx.fillText(label, textX, rowCenter - 10);

    ctx.fillStyle = COLORS.muted;
    ctx.font = font("", 14);
    ctx.fillText(`${formatCount(row.count)} messages`, textX, rowCenter + 14);

    ctx.textAlign = "right";
    ctx.fillStyle = accent;
    ctx.font = font("600", 22);
    ctx.fillText(row.shareLabel, contentRight, rowCenter - 8);

    ctx.fillStyle = COLORS.muted;
    ctx.font = font("", 13);
    ctx.fillText("of server traffic", contentRight, rowCenter + 16);
    ctx.textAlign = "left";

    const barX = textX;
    const barY = rowTop + rowHeight - 18;
    const barW = contentRight - barX;
    const barH = 7;
    const shareValue = row.sharePct;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.fill();
    const fillW = shareValue > 0 ? Math.max(6, (shareValue / maxShare) * barW) : 0;
    ctx.fillStyle = hexToRgba(accent, row.rank === 1 ? 1 : 0.72);
    roundRect(ctx, barX, barY, fillW, barH, 4);
    ctx.fill();

    y += rowHeight + rowGap;
  }

  return canvas.toBuffer("image/png");
}
