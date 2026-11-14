import type { Player } from "lavalink-client";
import { leadingLiveCount } from "../radio/tags.js";

// Positions here are what people see: 1-based, after any hidden radio "live" entries at the front.

export type RemoveResult = { ok: true; title: string } | { ok: false; reason: "out_of_range" };

export async function removeAt(player: Player, index: number): Promise<RemoveResult> {
  const zeroBased = index - 1 + leadingLiveCount(player);
  const track = index >= 1 ? player.queue.tracks[zeroBased] : undefined;
  if (!track) return { ok: false, reason: "out_of_range" };
  await player.queue.remove(zeroBased);
  return { ok: true, title: track.info.title };
}

export type MoveResult = { ok: true } | { ok: false; reason: "out_of_range" };

export async function move(player: Player, from: number, to: number): Promise<MoveResult> {
  const hidden = leadingLiveCount(player);
  const fromIdx = from - 1 + hidden;
  const toIdx = to - 1 + hidden;
  const track = from >= 1 ? player.queue.tracks[fromIdx] : undefined;
  if (!track || to < 1 || toIdx >= player.queue.tracks.length) return { ok: false, reason: "out_of_range" };
  await player.queue.splice(fromIdx, 1);
  await player.queue.splice(toIdx, 0, track);
  return { ok: true };
}

/** Clears the visible queue; a station that's on air keeps playing. */
export async function clearQueue(player: Player): Promise<number> {
  const hidden = leadingLiveCount(player);
  const count = player.queue.tracks.length - hidden;
  if (count > 0) await player.queue.splice(hidden, count);
  return count;
}

/** Shuffles the visible queue, leaving any hidden radio entries at the front. */
export async function shuffleQueue(player: Player): Promise<number> {
  const hidden = leadingLiveCount(player);
  if (hidden === 0) return player.queue.shuffle();
  const live = player.queue.tracks.slice(0, hidden);
  await player.queue.splice(0, hidden);
  const count = await player.queue.shuffle();
  await player.queue.add(live, 0);
  return count;
}
