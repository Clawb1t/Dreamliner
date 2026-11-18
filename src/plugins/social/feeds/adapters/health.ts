import { safeFetch } from "../../../../core/safeFetch.js";
import type { FeedAdapter, FeedItemInput, FeedSourceRecord } from "../types.js";
import { FEED_ACCEPT_JSON } from "./http.js";

/**
 * Status feeds for services that only expose a health check (no incident feed), e.g. a bot's
 * API. Each poll checks the health URL; the feed's items are the up/down transitions, so a
 * post goes out when the service goes down and again when it recovers. Two failed checks in a row
 * count as down, so one blip never posts. State lives in memory per source: after a restart the
 * first check is the new baseline and nothing is posted for it.
 *
 * Config: { healthUrl, statsUrl?, serviceName }. A healthy answer is HTTP 200 whose JSON (when it
 * has one) doesn't say otherwise ({status: 200|"ok"|"healthy"} or no status field at all).
 */

export const HEALTH_FAILS_FOR_DOWN = 2;
const MAX_EVENTS = 10;

export type HealthStats = { servers: number | null; users: number | null; latencyMs: number | null };
export type HealthState = { healthy: boolean | null; failStreak: number; downSince: number | null; events: FeedItemInput[] };

const states = new Map<string, HealthState>();

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function utcTime(at: number): string {
  return new Date(at).toISOString().slice(11, 16) + " UTC";
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ""}`;
}

/**
 * Pure state step: folds one check result into the state and returns the new state. Exported for
 * tests. `siteUrl` is where posts link to.
 */
export function stepHealth(
  previous: HealthState | undefined,
  check: { healthy: boolean; stats: HealthStats | null; at: number },
  meta: { serviceName: string; siteUrl: string; iconUrl: string | null },
): HealthState {
  const state: HealthState = previous
    ? { ...previous, events: [...previous.events] }
    : { healthy: null, failStreak: 0, downSince: null, events: [] };

  if (check.healthy) {
    if (state.healthy === false) {
      const down = state.downSince ?? check.at;
      const parts = [`${meta.serviceName} is responding again after ${duration(check.at - down)}.`];
      const stats = check.stats;
      if (stats) {
        const bits = [
          stats.servers != null ? `${n(stats.servers)} servers` : null,
          stats.users != null ? `${n(stats.users)} users` : null,
          stats.latencyMs != null ? `${n(Math.round(stats.latencyMs))} ms latency` : null,
        ].filter(Boolean);
        if (bits.length) parts.push(`Now serving ${bits.join(", ")}.`);
      }
      state.events.push({
        key: `up:${check.at}`,
        title: `${meta.serviceName} is back up`,
        url: meta.siteUrl,
        imageUrl: null,
        summary: parts.join(" "),
        author: meta.serviceName,
        tags: ["resolved"],
        publishedAt: new Date(check.at),
        payload: { status: "up", downSince: down },
      });
    }
    state.healthy = true;
    state.failStreak = 0;
    state.downSince = null;
  } else {
    state.failStreak += 1;
    if (state.failStreak === 1 && state.healthy !== false) state.downSince = check.at;
    if (state.failStreak >= HEALTH_FAILS_FOR_DOWN && state.healthy !== false) {
      // Only a known-up service going down posts; a first-ever failing check is just the baseline.
      if (state.healthy === true) {
        const since = state.downSince ?? check.at;
        state.events.push({
          key: `down:${since}`,
          title: `${meta.serviceName} is having problems`,
          url: meta.siteUrl,
          imageUrl: null,
          summary: `${meta.serviceName} stopped responding at ${utcTime(since)}. We'll post again when it's back.`,
          author: meta.serviceName,
          tags: ["outage"],
          publishedAt: new Date(since),
          payload: { status: "down" },
        });
      }
      state.healthy = false;
    }
  }
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  return state;
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const res = await safeFetch(url, { accept: FEED_ACCEPT_JSON, timeoutMs: 10_000, maxBytes: 64 * 1024 });
    if (res.status !== 200) return false;
    try {
      const json = JSON.parse(res.body.toString("utf8")) as { status?: unknown };
      if (json && typeof json === "object" && "status" in json) {
        const s = json.status;
        return s === 200 || s === "200" || (typeof s === "string" && /^(ok|healthy|up|operational)$/i.test(s));
      }
    } catch {
      /* not JSON: a 200 is enough */
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchStats(url: string): Promise<HealthStats | null> {
  try {
    const res = await safeFetch(url, { accept: FEED_ACCEPT_JSON, timeoutMs: 10_000, maxBytes: 256 * 1024 });
    const json = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
    return { servers: count(json.guilds ?? json.servers), users: count(json.users), latencyMs: count(json.latency ?? json.ping) };
  } catch {
    return null;
  }
}

export const healthCheckAdapter: FeedAdapter = {
  async fetch(source: FeedSourceRecord) {
    const healthUrl = String(source.config.healthUrl ?? "");
    const statsUrl = typeof source.config.statsUrl === "string" ? source.config.statsUrl : null;
    const serviceName = String(source.config.serviceName ?? source.title);
    const healthy = await checkHealth(healthUrl);
    const stats = healthy && statsUrl ? await fetchStats(statsUrl) : null;
    const next = stepHealth(states.get(source.key), { healthy, stats, at: Date.now() }, {
      serviceName,
      siteUrl: source.siteUrl ?? healthUrl,
      iconUrl: source.iconUrl,
    });
    states.set(source.key, next);
    // A failing check is the service's outage, not a broken feed: never throw, so the source isn't
    // backed off or auto-disabled while the thing it watches is down.
    return { items: next.events };
  },
};
