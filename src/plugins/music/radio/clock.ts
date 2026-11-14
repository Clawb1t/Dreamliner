import { getDb } from "../../../db/client.js";
import { radioStationState } from "../../../db/schema.js";
import { getLogger } from "../../../core/logger.js";
import { jumpPast, livePosition, nextAfter, normalize, playOrder, type ClockState, type LivePosition } from "./clockMath.js";
import { listAllTracks, listStations, type RadioStationRow, type RadioTrackRow } from "./store.js";

/**
 * The running clocks for every station. Loaded once at boot from radio_station_state with the
 * anchor moved to "now", so a station carries on from exactly where it was when the bot stopped.
 * Saved every few seconds and on shutdown.
 */

const log = getLogger("music");
const SAVE_INTERVAL_MS = 5_000;

type StationClock = {
  station: RadioStationRow;
  order: RadioTrackRow[];
  state: ClockState;
};

const clocks = new Map<string, StationClock>();
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;
const changeListeners = new Set<(stationId: string) => void>();

export type RadioLive = LivePosition & { track: RadioTrackRow; next: RadioTrackRow | null; station: RadioStationRow };

function buildOrder(station: RadioStationRow, tracks: RadioTrackRow[], seed: number): RadioTrackRow[] {
  return playOrder(tracks, station.shuffle, seed);
}

/** Loads (or reloads) every station's clock. On first load the anchor is "now": downtime doesn't count. */
export async function loadRadioClocks(): Promise<void> {
  const db = getDb();
  const stations = await listStations();
  const tracks = await listAllTracks();
  const saved = new Map((await db.select().from(radioStationState).all()).map((row) => [row.stationId, row]));
  const now = Date.now();
  const seen = new Set<string>();
  for (const station of stations) {
    seen.add(station.id);
    const stationTracks = tracks.filter((t) => t.stationId === station.id);
    const existing = clocks.get(station.id);
    const row = saved.get(station.id);
    const state: ClockState = existing
      ? normalize(existing.state, existing.order, now)
      : {
          currentTrackId: row?.currentTrackId ?? null,
          offsetMs: row?.offsetMs ?? 0,
          anchorAt: now,
          orderSeed: row?.orderSeed ?? Math.floor(Math.random() * 2 ** 31),
        };
    clocks.set(station.id, { station, order: buildOrder(station, stationTracks, state.orderSeed), state });
  }
  for (const id of clocks.keys()) if (!seen.has(id)) clocks.delete(id);
  if (!loaded) {
    loaded = true;
    startSaving();
    log.info(`Loaded ${clocks.size} radio station clock(s).`);
  }
}

/** Re-reads one station after an edit (tracks added/removed/reordered, shuffle changed). */
export async function refreshStationClock(stationId: string, options: { reseed?: boolean } = {}): Promise<void> {
  const before = clocks.get(stationId);
  const liveBefore = getLive(stationId)?.track.id ?? null;
  const nextBefore = getLive(stationId)?.next?.id ?? null;
  if (before && options.reseed) {
    before.state = { ...normalize(before.state, before.order, Date.now()), orderSeed: Math.floor(Math.random() * 2 ** 31) };
  }
  await loadRadioClocks();
  if (!clocks.has(stationId)) return;
  flushStation(stationId);
  // Only re-sync tuned-in servers when what's playing (or coming next) actually changed, so a
  // rename or icon change doesn't restart the song for everyone.
  const live = getLive(stationId);
  if ((live?.track.id ?? null) !== liveBefore || (live?.next?.id ?? null) !== nextBefore) emitChange(stationId);
}

export function forgetStationClock(stationId: string): void {
  clocks.delete(stationId);
  emitChange(stationId);
}

export function getLive(stationId: string, now = Date.now()): RadioLive | null {
  const clock = clocks.get(stationId);
  if (!clock) return null;
  const live = livePosition(clock.state, clock.order, now);
  if (!live) return null;
  return {
    ...live,
    track: live.track as RadioTrackRow,
    next: nextAfter(clock.order, live.index) as RadioTrackRow | null,
    station: clock.station,
  };
}

/** Stations that can be tuned into (live and with at least one track), in display order. */
export function liveStations(): RadioStationRow[] {
  return [...clocks.values()]
    .filter((c) => c.station.visibility === "live" && c.order.length > 0)
    .map((c) => c.station)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
}

export function getStationFromClock(stationId: string): RadioStationRow | null {
  return clocks.get(stationId)?.station ?? null;
}

export function stationTrackCount(stationId: string): { count: number; totalMs: number } {
  const order = clocks.get(stationId)?.order ?? [];
  return { count: order.length, totalMs: order.reduce((sum, t) => sum + t.durationMs, 0) };
}

/** Skips the station (every server tuned in) to the start of the next song. */
export function skipStation(stationId: string): boolean {
  const clock = clocks.get(stationId);
  const live = clock ? livePosition(clock.state, clock.order, Date.now()) : null;
  if (!clock || !live) return false;
  clock.state = jumpPast(clock.state, clock.order, live.track.id, Date.now());
  flushStation(stationId);
  emitChange(stationId);
  return true;
}

/**
 * Call BEFORE deleting a track: if it's on air, the station moves on to what was coming next
 * instead of restarting from the top.
 */
export function moveOffTrack(stationId: string, trackId: string): void {
  const clock = clocks.get(stationId);
  if (!clock) return;
  const live = livePosition(clock.state, clock.order, Date.now());
  if (live?.track.id !== trackId) return;
  clock.state = jumpPast(clock.state, clock.order, trackId, Date.now());
  flushStation(stationId);
}

/** Lets the controller re-sync tuned-in servers after a skip or a track list change. */
export function onStationChange(listener: (stationId: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitChange(stationId: string): void {
  for (const listener of changeListeners) {
    try {
      listener(stationId);
    } catch (error) {
      log.error(`Radio change listener failed for station ${stationId}:`, error);
    }
  }
}

function flushStation(stationId: string): void {
  const clock = clocks.get(stationId);
  if (!clock) return;
  const now = Date.now();
  const state = normalize(clock.state, clock.order, now);
  clock.state = state;
  const values = {
    stationId,
    currentTrackId: state.currentTrackId,
    offsetMs: Math.round(state.offsetMs),
    orderSeed: state.orderSeed,
    savedAt: new Date(now),
  };
  // better-sqlite3 runs synchronously, which is what lets this work inside a signal handler.
  getDb()
    .insert(radioStationState)
    .values(values)
    .onConflictDoUpdate({ target: [radioStationState.stationId], set: values })
    .run();
}

export function flushAllRadioClocks(): void {
  for (const id of clocks.keys()) {
    try {
      flushStation(id);
    } catch (error) {
      log.error(`Failed to save radio clock for station ${id}:`, error);
    }
  }
}

function startSaving(): void {
  if (saveTimer) return;
  saveTimer = setInterval(flushAllRadioClocks, SAVE_INTERVAL_MS);
  saveTimer.unref();

  // Save the exact position on a clean shutdown, then let the signal carry on as normal.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      flushAllRadioClocks();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
  process.once("beforeExit", flushAllRadioClocks);
}
