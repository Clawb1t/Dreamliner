import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

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
