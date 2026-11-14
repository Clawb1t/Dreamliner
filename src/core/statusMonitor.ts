import { Status, type Client } from "discord.js";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { botStatusDaily, botStatusSamples, commandUsageDaily } from "../db/schema.js";
import { takeCommandCount } from "./runtimeCounters.js";
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
  /** Deeper live readings for the status page (all public-safe: no versions, hosts or ids). */
  health: {
    /** Members across every server (Discord's member counts, not cached members). */
    members: number;
    heapUsedMb: number;
    heapTotalMb: number;
    /** Process CPU over the last sample minute, % of one core. Null until the first sample. */
    cpuPct: number | null;
    /** Event-loop delay p99 over the last sample minute, in ms. Null until the first sample. */
    eventLoopMs: number | null;
    shards: Array<{ id: number; status: StatusLevel; pingMs: number | null }>;
    plugins: number;
    commands: number;
  };
  components: Array<{
    id: string;
    name: string;
    description: string;
    status: StatusLevel;
    /** A short live reading for the row, e.g. "2.1 ms". */
    detail?: string;
  }>;
  uptime: {
    last90dPct: number | null;
    /** Sample-based uptime over shorter windows (same method as the 90-day figure). */
    windows: { h24: number | null; d7: number | null; d30: number | null };
    days: Array<{
      date: string;
      uptimePct: number | null;
      samples: number;
      avgPingMs: number | null;
      maxPingMs: number | null;
    }>;
  };
  /** Latency spread over the chart range, from raw per-minute samples. */
  pingStats: { minMs: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number; samples: number } | null;
  /** Process health per bucket over the chart range. */
  system: {
    range: "24h" | "7d";
    points: Array<{ at: string; ramUsageMb: number | null; heapUsedMb: number | null; cpuPct: number | null; eventLoopMs: number | null; commands: number | null }>;
  };
  usage: {
    commandsToday: number;
    commands7d: number;
    /** Commands in the last hour, from the per-minute samples. */
    commandsLastHour: number;
    /** Most used commands over the last 7 days, across every server. */
    top: Array<{ name: string; uses: number }>;
  };
  /** Detected incidents in the last 30 days, newest first. */
  incidents: Array<{
    kind: "offline" | "gateway" | "latency";
    startedAt: string;
    endedAt: string | null;
    durationSeconds: number;
  }>;
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

// Process health, measured between samples.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let lastCpu = process.cpuUsage();
let lastCpuAt = performance.now();
let lastHealth: { cpuPct: number; eventLoopMs: number } | null = null;

/** CPU (% of one core) and event-loop p99 since the last call, then resets both windows. */
function takeProcessHealth(): { cpuPct: number; eventLoopMs: number } {
  const now = performance.now();
  const cpu = process.cpuUsage(lastCpu);
  const elapsedMs = Math.max(1, now - lastCpuAt);
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  const cpuPct = Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10;
  const p99 = loopDelay.percentile(99) / 1e6;
  loopDelay.reset();
  lastHealth = { cpuPct: Math.min(cpuPct, 400), eventLoopMs: Number.isFinite(p99) ? Math.round(p99 * 10) / 10 : 0 };
  return lastHealth;
}

let inventory = { plugins: 0, commands: 0 };
/** Plugin and command counts for the status page, set once plugins are loaded (bot.ts). */
export function setStatusInventory(next: { plugins: number; commands: number }): void {
  inventory = next;
}

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
  if (!ready) return "outage";
  // Ready but no heartbeat round-trip yet (the first seconds after connecting): connected, just
  // not measured, so not an outage.
  if (pingMs == null || pingMs < 0) return "operational";
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
  // Up = connected and ready. A missing ping only means the first heartbeat hasn't come back yet
  // (right after a restart), which used to log a false "gateway down" minute on every boot.
  const ok = live.ready;
  const lavalink = getLavalinkStatusSummary();
  const health = takeProcessHealth();
  const db = getDb();

  await db.insert(botStatusSamples).values({
    cpuPct: health.cpuPct,
    eventLoopMs: health.eventLoopMs,
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
    commands: takeCommandCount(),
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

const windowOf = (range: "24h" | "7d") => (range === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000);
const bucketOf = (range: "24h" | "7d") => (range === "24h" ? 5 * 60 * 1000 : 60 * 60 * 1000);

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function loadPingStats(range: "24h" | "7d"): Promise<PublicBotStatusPayload["pingStats"]> {
  const rows = await getDb()
    .select({ wsPingMs: botStatusSamples.wsPingMs })
    .from(botStatusSamples)
    .where(and(gte(botStatusSamples.sampledAt, Date.now() - windowOf(range)), eq(botStatusSamples.ok, true)))
    .all();
  const values = rows
    .map((r) => r.wsPingMs)
    .filter((v): v is number => v != null && v >= 0)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  return {
    minMs: values[0]!,
    avgMs: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: values[values.length - 1]!,
    samples: values.length,
  };
}

/** RAM, heap, CPU, event loop (averaged) and commands (summed) per bucket. */
async function loadSystemSeries(range: "24h" | "7d"): Promise<PublicBotStatusPayload["system"]["points"]> {
  const bucketMs = bucketOf(range);
  const rows = await getDb()
    .select({
      sampledAt: botStatusSamples.sampledAt,
      ram: botStatusSamples.ramUsageMb,
      heap: botStatusSamples.heapUsedMb,
      cpu: botStatusSamples.cpuPct,
      loop: botStatusSamples.eventLoopMs,
      commands: botStatusSamples.commands,
    })
    .from(botStatusSamples)
    .where(gte(botStatusSamples.sampledAt, Date.now() - windowOf(range)))
    .orderBy(asc(botStatusSamples.sampledAt))
    .all();
  type Acc = { sum: number; n: number };
  const fresh = (): Acc => ({ sum: 0, n: 0 });
  const buckets = new Map<number, { ram: Acc; heap: Acc; cpu: Acc; loop: Acc; commands: Acc }>();
  const add = (acc: Acc, v: number | null) => {
    if (v == null || v < 0) return;
    acc.sum += v;
    acc.n += 1;
  };
  for (const row of rows) {
    const key = Math.floor(row.sampledAt / bucketMs) * bucketMs;
    let b = buckets.get(key);
    if (!b) {
      b = { ram: fresh(), heap: fresh(), cpu: fresh(), loop: fresh(), commands: fresh() };
      buckets.set(key, b);
    }
    add(b.ram, row.ram);
    add(b.heap, row.heap);
    add(b.cpu, row.cpu);
    add(b.loop, row.loop);
    add(b.commands, row.commands);
  }
  const avg = (acc: Acc, digits = 0) => (acc.n ? Math.round((acc.sum / acc.n) * 10 ** digits) / 10 ** digits : null);
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, b]) => ({
      at: new Date(at).toISOString(),
      ramUsageMb: avg(b.ram),
      heapUsedMb: avg(b.heap),
      cpuPct: avg(b.cpu, 1),
      eventLoopMs: avg(b.loop, 1),
      commands: b.commands.n ? b.commands.sum : null,
    }));
}

const INCIDENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A gap this long between samples means the bot wasn't running. */
const OFFLINE_GAP_MS = 3 * SAMPLE_INTERVAL_MS;
/** Most incidents returned (the page shows "50+" when it hits this). */
const INCIDENT_LIMIT = 50;
/** Consecutive high-latency samples before it counts as an incident. */
const LATENCY_RUN = 3;

/**
 * One pass over the last 30 days of samples: incidents (offline gaps, gateway drops, sustained
 * high latency), uptime over 24 h / 7 d / 30 d, and commands in the last hour.
 */
async function loadIncidentsAndWindows(): Promise<{
  incidents: PublicBotStatusPayload["incidents"];
  windows: PublicBotStatusPayload["uptime"]["windows"];
  commandsLastHour: number;
}> {
  const now = Date.now();
  const rows = await getDb()
    .select({ at: botStatusSamples.sampledAt, ok: botStatusSamples.ok, ping: botStatusSamples.wsPingMs, commands: botStatusSamples.commands })
    .from(botStatusSamples)
    .where(gte(botStatusSamples.sampledAt, now - INCIDENT_WINDOW_MS))
    .orderBy(asc(botStatusSamples.sampledAt))
    .all();

  const incidents: PublicBotStatusPayload["incidents"] = [];
  const push = (kind: "offline" | "gateway" | "latency", start: number, end: number | null) => {
    const durationSeconds = Math.max(60, Math.round(((end ?? now) - start) / 1000));
    incidents.push({ kind, startedAt: new Date(start).toISOString(), endedAt: end ? new Date(end).toISOString() : null, durationSeconds });
  };
  const limits = { h24: now - 24 * 3600_000, d7: now - 7 * 24 * 3600_000, d30: now - INCIDENT_WINDOW_MS };
  const counts: Record<keyof typeof limits, { up: number; total: number }> = {
    h24: { up: 0, total: 0 },
    d7: { up: 0, total: 0 },
    d30: { up: 0, total: 0 },
  };
  let commandsLastHour = 0;
  let downStart: number | null = null;
  let slowStart: number | null = null;
  let slowRun = 0;
  let prev: number | null = null;

  for (const row of rows) {
    for (const key of ["h24", "d7", "d30"] as const) {
      if (row.at < limits[key]) continue;
      counts[key].total += 1;
      if (row.ok) counts[key].up += 1;
    }
    if (row.at >= now - 3600_000) commandsLastHour += row.commands ?? 0;
    if (prev !== null && row.at - prev > OFFLINE_GAP_MS) push("offline", prev + SAMPLE_INTERVAL_MS, row.at);
    prev = row.at;

    if (!row.ok) {
      downStart ??= row.at;
    } else if (downStart !== null) {
      push("gateway", downStart, row.at);
      downStart = null;
    }
    const slow = row.ok && row.ping != null && row.ping >= DEGRADED_PING_MS;
    if (slow) {
      slowStart ??= row.at;
      slowRun += 1;
    } else {
      if (slowStart !== null && slowRun >= LATENCY_RUN) push("latency", slowStart, row.at);
      slowStart = null;
      slowRun = 0;
    }
  }
  if (downStart !== null) push("gateway", downStart, null);
  if (slowStart !== null && slowRun >= LATENCY_RUN) push("latency", slowStart, null);

  const pct = (c: { up: number; total: number }) => (c.total > 0 ? (c.up / c.total) * 100 : null);
  incidents.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    incidents: incidents.slice(0, INCIDENT_LIMIT),
    windows: { h24: pct(counts.h24), d7: pct(counts.d7), d30: pct(counts.d30) },
    commandsLastHour,
  };
}

async function loadCommandUsage(): Promise<Omit<PublicBotStatusPayload["usage"], "commandsLastHour">> {
  const today = utcDateKey(Date.now());
  const weekStart = utcDateKey(Date.now() - 6 * 24 * 60 * 60 * 1000);
  const db = getDb();
  const uses = sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)`;
  const [todayRow, weekRow, top] = await Promise.all([
    db.select({ total: uses }).from(commandUsageDaily).where(eq(commandUsageDaily.statDate, today)).get(),
    db.select({ total: uses }).from(commandUsageDaily).where(gte(commandUsageDaily.statDate, weekStart)).get(),
    db
      .select({ name: commandUsageDaily.commandName, uses })
      .from(commandUsageDaily)
      .where(gte(commandUsageDaily.statDate, weekStart))
      .groupBy(commandUsageDaily.commandName)
      .orderBy(desc(uses))
      .limit(6)
      .all(),
  ]);
  return {
    commandsToday: Number(todayRow?.total ?? 0),
    commands7d: Number(weekRow?.total ?? 0),
    top: top.map((r) => ({ name: r.name, uses: Number(r.uses) })),
  };
}

function shardStatus(client: Client): PublicBotStatusPayload["health"]["shards"] {
  const shards = (client.ws as unknown as { shards?: Map<number, { id: number; status: number; ping: number }> }).shards;
  if (!shards || typeof shards.values !== "function") return [];
  return [...shards.values()].map((shard) => {
    const pingMs = Number.isFinite(shard.ping) && shard.ping >= 0 ? Math.round(shard.ping) : null;
    return { id: shard.id, status: classifyGateway(shard.status === Status.Ready, pingMs), pingMs };
  });
}

/** Times a trivial query: the database is local SQLite, so anything slow means trouble. */
function databaseCheck(): { status: StatusLevel; ms: number | null } {
  const started = performance.now();
  try {
    getDb().get(sql`select 1`);
    const ms = Math.round((performance.now() - started) * 10) / 10;
    return { status: ms > 250 ? "degraded" : "operational", ms };
  } catch {
    return { status: "outage", ms: null };
  }
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
      return { date, uptimePct: null, samples: 0, avgPingMs: null, maxPingMs: null };
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
      maxPingMs: row.pingCount > 0 ? row.pingMax : null,
    };
  });

  const database = databaseCheck();
  const [pingStats, system, derived, usage] = await Promise.all([loadPingStats(pingRange), loadSystemSeries(pingRange), loadIncidentsAndWindows(), loadCommandUsage()]);
  const memory = process.memoryUsage();
  let members = 0;
  for (const guild of client.guilds.cache.values()) members += guild.memberCount ?? 0;
  const ms = (v: number | null) => (v == null ? undefined : `${v} ms`);

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
    health: {
      members,
      heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
      heapTotalMb: Math.round(memory.heapTotal / (1024 * 1024)),
      cpuPct: lastHealth?.cpuPct ?? null,
      eventLoopMs: lastHealth?.eventLoopMs ?? null,
      shards: shardStatus(client),
      plugins: inventory.plugins,
      commands: inventory.commands,
    },
    components: [
      {
        id: "gateway",
        name: "Discord gateway",
        description: "Websocket connection used for real-time Discord events.",
        status: gatewayStatus,
        detail: ms(live.wsPingMs),
      },
      {
        id: "api",
        name: "Commands & events",
        description: "Dreamliner process handling slash commands, buttons and server events.",
        status: apiStatus,
        detail: lastHealth ? `${lastHealth.eventLoopMs} ms loop` : undefined,
      },
      {
        id: "database",
        name: "Database",
        description: "Server settings, cases, stats and everything plugins store.",
        status: database.status,
        detail: database.ms == null ? undefined : database.ms < 1 ? "<1 ms" : `${database.ms} ms`,
      },
      {
        id: "dashboard",
        name: "Dashboard & API",
        description: "The link between dreamliner.site and the bot that saves your settings.",
        status: "operational",
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
              detail: lavalink.connected ? `${lavalink.playingPlayers} playing` : undefined,
            },
          ]
        : []),
    ],
    lavalink,
    uptime: {
      last90dPct: sampleTotal > 0 ? (upTotal / sampleTotal) * 100 : null,
      windows: derived.windows,
      days,
    },
    pingStats,
    system: { range: pingRange, points: system },
    usage: { ...usage, commandsLastHour: derived.commandsLastHour },
    incidents: derived.incidents,
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
