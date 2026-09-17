import { Status, type Client } from "discord.js";
import { and, asc, eq, gte, lt, lte } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { botStatusDaily, botStatusSamples } from "../db/schema.js";
import { registerIntervalTask } from "./scheduler.js";
import { getLogger } from "./logger.js";
import { getLavalinkStatusSummary, type LavalinkStatusSummary } from "../plugins/music/functions/manager.js";
const log = getLogger("core");

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
    /** Resident set size of this Node process, in MB — the whole footprint (heap, buffers, the
     *  V8/Node runtime itself), not just JS heap, since that's what actually shows up in a host's
     *  memory graph. Always available (no sampling needed, unlike ping) since it's read live off
     *  the current process rather than a historical table. */
    ramUsageMb: number;
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
  servers: {
    range: "24h" | "7d";
    points: Array<{ at: string; guildCount: number }>;
  };
  ram: {
    range: "24h" | "7d";
    points: Array<{ at: string; ramUsageMb: number }>;
  };
  /** null when the bot isn't configured for music at all — not shown as a failure, just omitted. */
  lavalink: LavalinkStatusSummary | null;
  lavalinkSeries: {
    range: "24h" | "7d";
    points: Array<{
      at: string;
      players: number;
      playingPlayers: number;
      memoryUsedMb: number | null;
      cpuLoadPct: number | null;
    }>;
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

function readLive(client: Client): {
  ready: boolean;
  wsPingMs: number | null;
  guildCount: number;
  ramUsageMb: number;
} {
  const ready = client.isReady() && client.ws.status === Status.Ready;
  const raw = client.ws.ping;
  const wsPingMs = ready && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  return {
    ready,
    wsPingMs,
    guildCount: client.guilds.cache.size,
    ramUsageMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
  };
}

async function recordSample(client: Client): Promise<void> {
  const now = Date.now();
  const live = readLive(client);
  const ok = live.ready && live.wsPingMs != null;
  const lavalink = getLavalinkStatusSummary();
  const db = getDb();

  await db.insert(botStatusSamples).values({
    sampledAt: now,
    ok,
    wsPingMs: live.wsPingMs,
    guildCount: live.guildCount,
    ramUsageMb: live.ramUsageMb,
    // Null whenever music isn't configured, or the node just wasn't connected at sample time —
    // loadLavalinkSeries skips null rows the same way loadPingSeries skips down samples.
    lavalinkPlayers: lavalink?.connected ? lavalink.players : null,
    lavalinkPlayingPlayers: lavalink?.connected ? lavalink.playingPlayers : null,
    lavalinkMemoryUsedMb: lavalink?.memory?.usedMb ?? null,
    lavalinkCpuLoadPct: lavalink?.cpu?.lavalinkLoadPct ?? null,
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

/** Same bucketing as loadPingSeries, but not gated on `ok` — the cached guild list (and so
 *  guildCount) survives a brief gateway hiccup, so there's no reason to drop those samples the
 *  way a down/degraded ping sample gets dropped. Only excludes rows from before the guildCount
 *  column existed (null). */
async function loadServerSeries(
  range: "24h" | "7d",
): Promise<Array<{ at: string; guildCount: number }>> {
  const now = Date.now();
  const windowMs = range === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const bucketMs = range === "24h" ? 5 * 60 * 1000 : 60 * 60 * 1000;
  const since = now - windowMs;

  const rows = await getDb()
    .select({
      sampledAt: botStatusSamples.sampledAt,
      guildCount: botStatusSamples.guildCount,
    })
    .from(botStatusSamples)
    .where(gte(botStatusSamples.sampledAt, since))
    .orderBy(asc(botStatusSamples.sampledAt))
    .all();

  const buckets = new Map<number, { sum: number; count: number }>();
  for (const row of rows) {
    if (row.guildCount == null || row.guildCount < 0) continue;
    const key = Math.floor(row.sampledAt / bucketMs) * bucketMs;
    const bucket = buckets.get(key) ?? { sum: 0, count: 0 };
    bucket.sum += row.guildCount;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, bucket]) => ({
      at: new Date(at).toISOString(),
      guildCount: Math.round(bucket.sum / bucket.count),
    }));
}

/** Same shape as loadServerSeries — RAM usage is read live off the process regardless of gateway
 *  state, so this isn't gated on `ok` either. Only excludes rows from before the ramUsageMb
 *  column existed (null). */
async function loadRamSeries(
  range: "24h" | "7d",
): Promise<Array<{ at: string; ramUsageMb: number }>> {
  const now = Date.now();
  const windowMs = range === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const bucketMs = range === "24h" ? 5 * 60 * 1000 : 60 * 60 * 1000;
  const since = now - windowMs;

  const rows = await getDb()
    .select({
      sampledAt: botStatusSamples.sampledAt,
      ramUsageMb: botStatusSamples.ramUsageMb,
    })
    .from(botStatusSamples)
    .where(gte(botStatusSamples.sampledAt, since))
    .orderBy(asc(botStatusSamples.sampledAt))
    .all();

  const buckets = new Map<number, { sum: number; count: number }>();
  for (const row of rows) {
    if (row.ramUsageMb == null || row.ramUsageMb < 0) continue;
    const key = Math.floor(row.sampledAt / bucketMs) * bucketMs;
    const bucket = buckets.get(key) ?? { sum: 0, count: 0 };
    bucket.sum += row.ramUsageMb;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, bucket]) => ({
      at: new Date(at).toISOString(),
      ramUsageMb: Math.round(bucket.sum / bucket.count),
    }));
}

/** Same bucketing again — skips rows where lavalinkPlayers is null (music unconfigured, or the
 *  node wasn't connected at sample time) the same way loadPingSeries skips down samples. Memory
 *  and CPU are averaged separately from player counts since a node can report a player count
 *  without (yet) having pushed a stats packet with memory/CPU in it. */
async function loadLavalinkSeries(range: "24h" | "7d"): Promise<PublicBotStatusPayload["lavalinkSeries"]["points"]> {
  const now = Date.now();
  const windowMs = range === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const bucketMs = range === "24h" ? 5 * 60 * 1000 : 60 * 60 * 1000;
  const since = now - windowMs;

  const rows = await getDb()
    .select({
      sampledAt: botStatusSamples.sampledAt,
      players: botStatusSamples.lavalinkPlayers,
      playingPlayers: botStatusSamples.lavalinkPlayingPlayers,
      memoryUsedMb: botStatusSamples.lavalinkMemoryUsedMb,
      cpuLoadPct: botStatusSamples.lavalinkCpuLoadPct,
    })
    .from(botStatusSamples)
    .where(gte(botStatusSamples.sampledAt, since))
    .orderBy(asc(botStatusSamples.sampledAt))
    .all();

  const buckets = new Map<
    number,
    { players: number; playingPlayers: number; count: number; memSum: number; memCount: number; cpuSum: number; cpuCount: number }
  >();
  for (const row of rows) {
    if (row.players == null) continue;
    const key = Math.floor(row.sampledAt / bucketMs) * bucketMs;
    const bucket = buckets.get(key) ?? {
      players: 0,
      playingPlayers: 0,
      count: 0,
      memSum: 0,
      memCount: 0,
      cpuSum: 0,
      cpuCount: 0,
    };
    bucket.players += row.players;
    bucket.playingPlayers += row.playingPlayers ?? 0;
    bucket.count += 1;
    if (row.memoryUsedMb != null) {
      bucket.memSum += row.memoryUsedMb;
      bucket.memCount += 1;
    }
    if (row.cpuLoadPct != null) {
      bucket.cpuSum += row.cpuLoadPct;
      bucket.cpuCount += 1;
    }
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, bucket]) => ({
      at: new Date(at).toISOString(),
      players: Math.round(bucket.players / bucket.count),
      playingPlayers: Math.round(bucket.playingPlayers / bucket.count),
      memoryUsedMb: bucket.memCount > 0 ? Math.round(bucket.memSum / bucket.memCount) : null,
      cpuLoadPct: bucket.cpuCount > 0 ? Math.round((bucket.cpuSum / bucket.cpuCount) * 10) / 10 : null,
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
  const lavalink = getLavalinkStatusSummary();

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
      ramUsageMb: live.ramUsageMb,
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
      // Only listed when music is actually configured — a server that doesn't run it shouldn't
      // show a permanently-red "outage" row for a feature it never turned on.
      ...(lavalink
        ? [
            {
              id: "lavalink",
              name: "Music (Lavalink)",
              description: "Audio streaming backend used by the music plugin.",
              status: (lavalink.connected ? "operational" : "outage") as StatusLevel,
            },
          ]
        : []),
    ],
    lavalink,
    uptime: {
      last90dPct: sampleTotal > 0 ? (upTotal / sampleTotal) * 100 : null,
      days,
    },
    ping: {
      range: pingRange,
      points: await loadPingSeries(pingRange),
    },
    servers: {
      range: pingRange,
      points: await loadServerSeries(pingRange),
    },
    ram: {
      range: pingRange,
      points: await loadRamSeries(pingRange),
    },
    lavalinkSeries: {
      range: pingRange,
      points: await loadLavalinkSeries(pingRange),
    },
  };
}

/** Start periodic sampling (always-on once ready). Safe to call multiple times. */
export function startStatusMonitor(client: Client): void {
  if (monitorStarted) return;
  monitorStarted = true;

  void recordSample(client).catch((error) => {
    log.warn(
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
