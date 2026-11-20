/**
 * The global leaderboards, frozen once per UTC day. The first build after 00:00 UTC is stored
 * (global_board_snapshots) and served for the rest of the day, restarts included, so watching a
 * board can't show when someone is active. Ghost Mode users are removed at serve time (see
 * `withoutHidden` in policy.ts), so turning it on hides someone straight away even though the
 * numbers stay frozen.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { globalBoardSnapshots } from "../../db/schema.js";
import { utcDate } from "./policy.js";

const memo = new Map<string, { date: string; value: unknown }>();
const building = new Map<string, Promise<unknown>>();

/** Today's frozen copy of `board`, built with `build` the first time it's asked for each UTC day. */
export async function frozenDaily<T>(board: string, build: () => Promise<T>, now = new Date()): Promise<T> {
  const date = utcDate(now);
  const hit = memo.get(board);
  if (hit?.date === date) return hit.value as T;

  const stored = getDb().select().from(globalBoardSnapshots).where(eq(globalBoardSnapshots.board, board)).get();
  if (stored?.snapshotDate === date) {
    try {
      const value = JSON.parse(stored.payload) as T;
      memo.set(board, { date, value });
      return value;
    } catch {
      /* unreadable: rebuild below */
    }
  }

  const key = `${board}:${date}`;
  const pending = building.get(key);
  if (pending) return pending as Promise<T>;
  const work = (async () => {
    const value = await build();
    const payload = JSON.stringify(value);
    getDb()
      .insert(globalBoardSnapshots)
      .values({ board, snapshotDate: date, payload, createdAt: new Date() })
      .onConflictDoUpdate({ target: globalBoardSnapshots.board, set: { snapshotDate: date, payload, createdAt: new Date() } })
      .run();
    memo.set(board, { date, value });
    return value;
  })().finally(() => building.delete(key));
  building.set(key, work);
  return work;
}

/** Tests only. */
export function resetFrozenBoardMemo(): void {
  memo.clear();
}
