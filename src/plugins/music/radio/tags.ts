import type { Player, Track, UnresolvedTrack } from "lavalink-client";

/** How a station's songs are marked on ordinary Lavalink tracks (see controller.ts). */
export type RadioTag = { stationId: string; stationName?: string; trackId?: string; kind: "live" | "ticket" };

export function radioTag(track: Track | UnresolvedTrack | null | undefined): RadioTag | null {
  const tag = (track?.userData as { radio?: RadioTag } | undefined)?.radio;
  return tag && typeof tag.stationId === "string" ? tag : null;
}

export function currentStationId(player: Player | null | undefined): string | null {
  return radioTag(player?.queue.current)?.stationId ?? null;
}

/** "Live" entries (a station's next song) sit hidden at the front of the queue. */
export function leadingLiveCount(player: Player): number {
  let count = 0;
  for (const track of player.queue.tracks) {
    if (radioTag(track)?.kind !== "live") break;
    count++;
  }
  return count;
}

/** The queue as people see it: without the hidden live entries. */
export function visibleQueue(player: Player): (Track | UnresolvedTrack)[] {
  return player.queue.tracks.slice(leadingLiveCount(player));
}

export const RADIO_ON_AIR_BLOCK = "A radio station is on air. Use /radio leave first.";
