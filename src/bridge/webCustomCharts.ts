import { and, asc, count, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { guildCustomCharts } from "../db/schema.js";

export const DAILY_METRICS = [
  "messages",
  "joins",
  "leaves",
  "net",
  "cumulativeNet",
  "edits",
  "deletes",
  "reactions",
  "attachments",
  "membershipVolume",
  "engagementVolume",
] as const;

export const WEEKDAY_METRICS = [
  "messages",
  "joins",
  "leaves",
  "engagement",
  "activeUsers",
] as const;

export const LEADERBOARD_WHICH = [
  "messagersWindow",
  "messagersAllTime",
  "channels",
] as const;

export const CHART_TYPES = ["line", "area", "bar", "pie"] as const;
export const WINDOW_DAYS = [7, 14, 30, 0] as const;

export type DailyMetric = (typeof DAILY_METRICS)[number];
export type WeekdayMetric = (typeof WEEKDAY_METRICS)[number];
export type LeaderboardWhich = (typeof LEADERBOARD_WHICH)[number];
export type ChartType = (typeof CHART_TYPES)[number];
export type WindowDays = (typeof WINDOW_DAYS)[number];

export type CustomChartSource =
  | { kind: "daily"; metrics: DailyMetric[] }
  | { kind: "activeUsers" }
  | { kind: "messagesPerActiveUser" }
  | { kind: "weekday"; metric: WeekdayMetric }
  | { kind: "engagementMix" }
  | { kind: "allTimeMix" }
  | { kind: "leaderboard"; which: LeaderboardWhich };

export type CustomChartDefinition = {
  id: string;
  title: string;
  chartType: ChartType;
  source: CustomChartSource;
  days: WindowDays | null;
  sortOrder: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CustomChartInput = {
  title: string;
  chartType: ChartType;
  source: CustomChartSource;
  days?: WindowDays | null;
  sortOrder?: number;
};

const MAX_CHARTS_PER_GUILD = 24;
const MAX_TITLE = 80;
const MAX_DAILY_METRICS = 4;

function isDailyMetric(value: unknown): value is DailyMetric {
  return typeof value === "string" && (DAILY_METRICS as readonly string[]).includes(value);
}

function isWeekdayMetric(value: unknown): value is WeekdayMetric {
  return typeof value === "string" && (WEEKDAY_METRICS as readonly string[]).includes(value);
}

function isLeaderboardWhich(value: unknown): value is LeaderboardWhich {
  return typeof value === "string" && (LEADERBOARD_WHICH as readonly string[]).includes(value);
}

function isChartType(value: unknown): value is ChartType {
  return typeof value === "string" && (CHART_TYPES as readonly string[]).includes(value);
}

function isWindowDays(value: unknown): value is WindowDays {
  return typeof value === "number" && (WINDOW_DAYS as readonly number[]).includes(value);
}

function parseSource(raw: unknown): CustomChartSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  switch (obj.kind) {
    case "daily": {
      if (!Array.isArray(obj.metrics)) return null;
      const metrics = [...new Set(obj.metrics.filter(isDailyMetric))];
      if (metrics.length === 0 || metrics.length > MAX_DAILY_METRICS) return null;
      return { kind: "daily", metrics };
    }
    case "activeUsers":
    case "messagesPerActiveUser":
    case "engagementMix":
    case "allTimeMix":
      return { kind: obj.kind };
    case "weekday":
      return isWeekdayMetric(obj.metric) ? { kind: "weekday", metric: obj.metric } : null;
    case "leaderboard":
      return isLeaderboardWhich(obj.which) ? { kind: "leaderboard", which: obj.which } : null;
    default:
      return null;
  }
}

function chartTypeAllowed(chartType: ChartType, source: CustomChartSource): boolean {
  switch (source.kind) {
    case "engagementMix":
    case "allTimeMix":
      return chartType === "pie" || chartType === "bar";
    case "leaderboard":
    case "weekday":
      return chartType === "bar";
    case "daily":
    case "activeUsers":
    case "messagesPerActiveUser":
      return chartType === "line" || chartType === "area" || chartType === "bar";
    default:
      return false;
  }
}

export function validateCustomChartInput(
  input: unknown,
): { ok: true; value: CustomChartInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid chart payload" };
  }
  const obj = input as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return { ok: false, error: "Title is required" };
  if (title.length > MAX_TITLE) return { ok: false, error: `Title must be ≤ ${MAX_TITLE} characters` };
  if (!isChartType(obj.chartType)) return { ok: false, error: "Invalid chart type" };
  const source = parseSource(obj.source);
  if (!source) return { ok: false, error: "Invalid data source / metrics" };
  if (!chartTypeAllowed(obj.chartType, source)) {
    return { ok: false, error: "Chart type is not valid for that data source" };
  }
  let days: WindowDays | null = null;
  if (obj.days !== undefined && obj.days !== null) {
    if (!isWindowDays(obj.days)) return { ok: false, error: "Invalid days window" };
    days = obj.days;
  }
  const sortOrder =
    typeof obj.sortOrder === "number" && Number.isFinite(obj.sortOrder)
      ? Math.max(0, Math.floor(obj.sortOrder))
      : 0;
  return {
    ok: true,
    value: {
      title,
      chartType: obj.chartType,
      source,
      days,
      sortOrder,
    },
  };
}

type DefinitionBlob = {
  source: CustomChartSource;
  days: WindowDays | null;
};

function serializeRow(row: typeof guildCustomCharts.$inferSelect): CustomChartDefinition {
  let parsed: DefinitionBlob = { source: { kind: "daily", metrics: ["messages"] }, days: null };
  try {
    const raw = JSON.parse(row.definitionJson) as Partial<DefinitionBlob>;
    const source = parseSource(raw.source);
    if (source) {
      parsed = {
        source,
        days: raw.days === null || raw.days === undefined ? null : isWindowDays(raw.days) ? raw.days : null,
      };
    }
  } catch {
    // keep fallback
  }
  return {
    id: row.id,
    title: row.title,
    chartType: isChartType(row.chartType) ? row.chartType : "line",
    source: parsed.source,
    days: parsed.days,
    sortOrder: row.sortOrder,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCustomCharts(guildId: string): Promise<CustomChartDefinition[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(guildCustomCharts)
    .where(eq(guildCustomCharts.guildId, guildId))
    .orderBy(asc(guildCustomCharts.sortOrder), asc(guildCustomCharts.createdAt));
  return rows.map(serializeRow);
}

export async function getCustomChart(
  guildId: string,
  chartId: string,
): Promise<CustomChartDefinition | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(guildCustomCharts)
    .where(and(eq(guildCustomCharts.guildId, guildId), eq(guildCustomCharts.id, chartId)))
    .get();
  return row ? serializeRow(row) : null;
}

export async function createCustomChart(
  guildId: string,
  userId: string,
  input: CustomChartInput,
): Promise<{ ok: true; chart: CustomChartDefinition } | { ok: false; error: string; status: number }> {
  const db = getDb();
  const [totalRow] = await db
    .select({ value: count() })
    .from(guildCustomCharts)
    .where(eq(guildCustomCharts.guildId, guildId));
  if (Number(totalRow?.value ?? 0) >= MAX_CHARTS_PER_GUILD) {
    return {
      ok: false,
      error: `This server already has ${MAX_CHARTS_PER_GUILD} custom charts.`,
      status: 400,
    };
  }

  const now = new Date();
  const id = randomUUID();
  const definitionJson = JSON.stringify({
    source: input.source,
    days: input.days ?? null,
  } satisfies DefinitionBlob);

  await db.insert(guildCustomCharts).values({
    id,
    guildId,
    title: input.title,
    chartType: input.chartType,
    definitionJson,
    sortOrder: input.sortOrder ?? 0,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  const chart = await getCustomChart(guildId, id);
  if (!chart) return { ok: false, error: "Failed to create chart", status: 500 };
  return { ok: true, chart };
}

export async function updateCustomChart(
  guildId: string,
  chartId: string,
  input: CustomChartInput,
): Promise<{ ok: true; chart: CustomChartDefinition } | { ok: false; error: string; status: number }> {
  const existing = await getCustomChart(guildId, chartId);
  if (!existing) return { ok: false, error: "Chart not found", status: 404 };

  const db = getDb();
  const definitionJson = JSON.stringify({
    source: input.source,
    days: input.days ?? null,
  } satisfies DefinitionBlob);

  await db
    .update(guildCustomCharts)
    .set({
      title: input.title,
      chartType: input.chartType,
      definitionJson,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      updatedAt: new Date(),
    })
    .where(and(eq(guildCustomCharts.guildId, guildId), eq(guildCustomCharts.id, chartId)));

  const chart = await getCustomChart(guildId, chartId);
  if (!chart) return { ok: false, error: "Failed to update chart", status: 500 };
  return { ok: true, chart };
}

export async function deleteCustomChart(
  guildId: string,
  chartId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const existing = await getCustomChart(guildId, chartId);
  if (!existing) return { ok: false, error: "Chart not found", status: 404 };
  const db = getDb();
  await db
    .delete(guildCustomCharts)
    .where(and(eq(guildCustomCharts.guildId, guildId), eq(guildCustomCharts.id, chartId)));
  return { ok: true };
}

export function customChartCatalog() {
  return {
    chartTypes: [...CHART_TYPES],
    windows: [...WINDOW_DAYS],
    dailyMetrics: [...DAILY_METRICS],
    weekdayMetrics: [...WEEKDAY_METRICS],
    leaderboards: [...LEADERBOARD_WHICH],
    maxCharts: MAX_CHARTS_PER_GUILD,
    maxDailyMetrics: MAX_DAILY_METRICS,
  };
}
