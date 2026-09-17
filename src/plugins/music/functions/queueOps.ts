import type { Player } from "lavalink-client";

export type RemoveResult = { ok: true; title: string } | { ok: false; reason: "out_of_range" };

export async function removeAt(player: Player, index: number): Promise<RemoveResult> {
  const zeroBased = index - 1;
  const track = player.queue.tracks[zeroBased];
  if (!track) return { ok: false, reason: "out_of_range" };
  await player.queue.remove(zeroBased);
  return { ok: true, title: track.info.title };
}

export type MoveResult = { ok: true } | { ok: false; reason: "out_of_range" };

export async function move(player: Player, from: number, to: number): Promise<MoveResult> {
  const fromIdx = from - 1;
  const toIdx = to - 1;
  const track = player.queue.tracks[fromIdx];
  if (!track || toIdx < 0 || toIdx >= player.queue.tracks.length) return { ok: false, reason: "out_of_range" };
  await player.queue.splice(fromIdx, 1);
  await player.queue.splice(toIdx, 0, track);
  return { ok: true };
}

export async function clearQueue(player: Player): Promise<number> {
  const count = player.queue.tracks.length;
  if (count > 0) await player.queue.splice(0, count);
  return count;
}
