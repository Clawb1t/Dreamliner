/**
 * Pure maths for a station's global clock. A station is "live": every server tuned in hears the
 * same song at the same point. The clock is stored as (current track, offset into it, when that
 * offset was true) and the live position is worked out from there, rolling over through the
 * station's play order. Kept free of I/O so it can be unit tested.
 */

export type ClockTrack = { id: string; durationMs: number };

export type ClockState = {
  currentTrackId: string | null;
  offsetMs: number;
  /** Epoch ms at which `offsetMs` was exact. The clock advances from here. */
  anchorAt: number;
  orderSeed: number;
};

export type LivePosition = { index: number; track: ClockTrack; offsetMs: number };

/** Anything shorter is treated as this long, so a broken 0ms file can't spin the clock. */
export const MIN_TRACK_MS = 1000;

function length(track: ClockTrack): number {
  return Math.max(MIN_TRACK_MS, Math.round(track.durationMs));
}

/** Small deterministic PRNG (mulberry32), so a seed always gives the same shuffle. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The station's play order: the track list as given, or a seeded shuffle of it. */
export function playOrder<T extends ClockTrack>(tracks: readonly T[], shuffle: boolean, seed: number): T[] {
  const order = [...tracks];
  if (!shuffle || order.length < 2) return order;
  const random = prng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Where the station is at `now`. Null only when the station has no tracks. */
export function livePosition(state: ClockState, order: readonly ClockTrack[], now: number): LivePosition | null {
  if (order.length === 0) return null;
  let index = state.currentTrackId ? order.findIndex((t) => t.id === state.currentTrackId) : -1;
  let elapsed = Math.max(0, now - state.anchorAt);
  if (index === -1) {
    // The track it was on is gone: start from the top of the order.
    index = 0;
  } else {
    elapsed += Math.max(0, state.offsetMs);
  }

  // Finish the current track, then skip whole laps of the station in one step.
  const first = length(order[index]!);
  if (elapsed < first) return { index, track: order[index]!, offsetMs: elapsed };
  elapsed -= first;
  index = (index + 1) % order.length;
  const lap = order.reduce((sum, t) => sum + length(t), 0);
  elapsed %= lap;
  while (elapsed >= length(order[index]!)) {
    elapsed -= length(order[index]!);
    index = (index + 1) % order.length;
  }
  return { index, track: order[index]!, offsetMs: elapsed };
}

/** Re-anchors the clock at `now` (same live position, fresh anchor). Called before saving. */
export function normalize(state: ClockState, order: readonly ClockTrack[], now: number): ClockState {
  const live = livePosition(state, order, now);
  if (!live) return { ...state, currentTrackId: null, offsetMs: 0, anchorAt: now };
  return { ...state, currentTrackId: live.track.id, offsetMs: live.offsetMs, anchorAt: now };
}

/** The track after the live one, which is what plays next. */
export function nextAfter(order: readonly ClockTrack[], index: number): ClockTrack | null {
  if (order.length === 0) return null;
  return order[(index + 1) % order.length]!;
}

/**
 * Moves the clock to the start of the track after `trackId` in `order` (used for an operator skip,
 * and when the playing track is deleted, so the station carries on with what was coming next).
 */
export function jumpPast(state: ClockState, order: readonly ClockTrack[], trackId: string, now: number): ClockState {
  const index = order.findIndex((t) => t.id === trackId);
  const next = index === -1 ? (order[0] ?? null) : nextAfter(order, index);
  return { ...state, currentTrackId: next?.id ?? null, offsetMs: 0, anchorAt: now };
}
