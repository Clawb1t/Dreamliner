import { Status, type Client } from "discord.js";
import { and, asc, eq, gte, lt, lte } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { botStatusDaily, botStatusSamples } from "../db/schema.js";
import { registerIntervalTask } from "./scheduler.js";

export type StatusLevel = "operational" | "degraded" | "outage";

export type PublicBotStatusPayload = {
  checkedAt: string;
  startedAt: string;
  overall: StatusLevel;
  message: string;
  current: {
    ready: boolean;
    wsPingMs: number | null;
    guildCount: number;
    uptimeSeconds: number;
  };
  components: Array<{
    id: string;
    name: string;
    description: string;
    status: StatusLevel;
  }>;
  uptime: {
    last90dPct: number | null;
    days: Array<{
      date: string;
      uptimePct: number | null;
      samples: number;
      avgPingMs: number | null;
    }>;
  };
  ping: {
    range: "24h" | "7d";
    points: Array<{ at: string; pingMs: number }>;
  };
};

const SAMPLE_INTERVAL_MS = 60_000;
const RETAIN_MS = 90 * 24 * 60 * 60 * 1000;
const DEGRADED_PING_MS = 500;
const processStartedAt = Date.now();

let monitorStarted = false;

function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function eachUtcDate(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${fromKey}T00:00:00.000Z`);
  const end = new Date(`${toKey}T00:00:00.000Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function classifyGateway(ready: boolean, pingMs: number | null): StatusLevel {
  if (!ready || pingMs == null || pingMs < 0) return "outage";
  if (pingMs >= DEGRADED_PING_MS) return "degraded";
  return "operational";
}

function overallMessage(level: StatusLevel): string {
  if (level === "operational") return "All systems operational";
  if (level === "degraded") return "Experiencing elevated latency";
  return "Major outage";
}

function readLive(client: Client): { ready: boolean; wsPingMs: number | null; guildCount: number } {
  const ready = client.isReady() && client.ws.status === Status.Ready;
  const raw = client.ws.ping;
  const wsPingMs = ready && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  return { ready, wsPingMs, guildCount: client.guilds.cache.size };
}

async function recordSample(client: Client): Promise<void> {
  const now = Date.now();
  const live = readLive(client);
  const ok = live.ready && live.wsPingMs != null;
  const db = getDb();

  await db.insert(botStatusSamples).values({
    sampledAt: now,
    ok,
    wsPingMs: live.wsPingMs,
  });

  const date = utcDateKey(now);
  const existing = await db
    .select()
    .from(botStatusDaily)
    .where(eq(botStatusDaily.statDate, date))
    .get();

  if (!existing) {
    await db.insert(botStatusDaily).values({
      statDate: date,
      upSamples: ok ? 1 : 0,
      downSamples: ok ? 0 : 1,
      pingSum: ok && live.wsPingMs != null ? live.wsPingMs : 0,
      pingCount: ok && live.wsPingMs != null ? 1 : 0,
      pingMax: ok && live.wsPingMs != null ? live.wsPingMs : 0,
    });
  } else {
    await db
      .update(botStatusDaily)
      .set({
        upSamples: existing.upSamples + (ok ? 1 : 0),
        downSamples: existing.downSamples + (ok ? 0 : 1),
        pingSum: existing.pingSum + (ok && live.wsPingMs != null ? live.wsPingMs : 0),
        pingCount: existing.pingCount + (ok && live.wsPingMs != null ? 1 : 0),
        pingMax: Math.max(
          existing.pingMax,
          ok && live.wsPingMs != null ? live.wsPingMs : 0,
        ),
      })
      .where(eq(botStatusDaily.statDate, date));
  }

  // Opportunistic prune (~once per hour of samples).
  if (Math.floor(now / SAMPLE_INTERVAL_MS) % 60 === 0) {
    const cutoff = now - RETAIN_MS;
    await db.delete(botStatusSamples).where(lt(botStatusSamples.sampledAt, cutoff));
    const cutoffDate = utcDateKey(cutoff);
    await db.delete(botStatusDaily).where(lt(botStatusDaily.statDate, cutoffDate));
  }
}

async function loadPingSeries(
  range: "24h" | "7d",
): Promise<Array<{ at: string; pingMs: number }>> {
  const now = Date.now();
  const windowMs = range === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const bucketMs = range === "24h" ? 5 * 60 * 1000 : 60 * 60 * 1000;
  const since = now - windowMs;

  const rows = await getDb()
    .select({
      sampledAt: botStatusSamples.sampledAt,
      wsPingMs: botStatusSamples.wsPingMs,
      ok: botStatusSamples.ok,
    })
    .from(botStatusSamples)
    .where(and(gte(botStatusSamples.sampledAt, since), eq(botStatusSamples.ok, true)))
    .orderBy(asc(botStatusSamples.sampledAt))
    .all();

  const buckets = new Map<number, { sum: number; count: number }>();
  for (const row of rows) {
    if (row.wsPingMs == null || row.wsPingMs < 0) continue;
    const key = Math.floor(row.sampledAt / bucketMs) * bucketMs;
    const bucket = buckets.get(key) ?? { sum: 0, count: 0 };
    bucket.sum += row.wsPingMs;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, bucket]) => ({
      at: new Date(at).toISOString(),
      pingMs: Math.round(bucket.sum / bucket.count),
    }));
}

export async function buildPublicBotStatus(
  client: Client,
  pingRange: "24h" | "7d" = "24h",
): Promise<PublicBotStatusPayload> {
  const live = readLive(client);
  const gatewayStatus = classifyGateway(live.ready, live.wsPingMs);
  // Reaching this handler means the bot process / bridge is up.
  const apiStatus: StatusLevel = "operational";
  const overall = gatewayStatus;

  const today = utcDateKey(Date.now());
  const start = utcDateKey(Date.now() - 89 * 24 * 60 * 60 * 1000);
  const dateKeys = eachUtcDate(start, today);

  const dailyRows = await getDb()
    .select()
    .from(botStatusDaily)
    .where(and(gte(botStatusDaily.statDate, start), lte(botStatusDaily.statDate, today)))
    .all();
  const byDate = new Map(dailyRows.map((row) => [row.statDate, row]));

  let upTotal = 0;
  let sampleTotal = 0;
  const days = dateKeys.map((date) => {
    const row = byDate.get(date);
    if (!row) {
      return { date, uptimePct: null, samples: 0, avgPingMs: null };
    }
    const samples = row.upSamples + row.downSamples;
    const uptimePct = samples > 0 ? (row.upSamples / samples) * 100 : null;
    if (samples > 0 && uptimePct != null) {
      upTotal += row.upSamples;
      sampleTotal += samples;
    }
    return {
      date,
      uptimePct,
      samples,
      avgPingMs: row.pingCount > 0 ? Math.round(row.pingSum / row.pingCount) : null,
    };
  });

  return {
    checkedAt: new Date().toISOString(),
    startedAt: new Date(processStartedAt).toISOString(),
    overall,
    message: overallMessage(overall),
    current: {
      ready: live.ready,
      wsPingMs: live.wsPingMs,
      guildCount: live.guildCount,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - processStartedAt) / 1000)),
    },
    components: [
      {
        id: "gateway",
        name: "Discord gateway",
        description: "Websocket connection used for real-time Discord events.",
        status: gatewayStatus,
      },
      {
        id: "api",
        name: "Bot process",
        description: "Dreamliner process serving slash commands and the dashboard bridge.",
        status: apiStatus,
      },
    ],
    uptime: {
      last90dPct: sampleTotal > 0 ? (upTotal / sampleTotal) * 100 : null,
      days,
    },
    ping: {
      range: pingRange,
      points: await loadPingSeries(pingRange),
    },
  };
}

/** Start periodic sampling (always-on once ready). Safe to call multiple times. */
export function startStatusMonitor(client: Client): void {
  if (monitorStarted) return;
  monitorStarted = true;

  void recordSample(client).catch((error) => {
    console.warn(
      "[status-monitor] initial sample failed:",
      error instanceof Error ? error.message : error,
    );
  });

  registerIntervalTask({
    id: "bot-status-monitor",
    intervalMs: SAMPLE_INTERVAL_MS,
    run: async (c) => {
      await recordSample(c);
    },
  });
}
