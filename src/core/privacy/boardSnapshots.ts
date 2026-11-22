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
import { getLogger } from "../logger.js";

const log = getLogger("privacy:boards");

const memo = new Map<string, { date: string; value: unknown }>();
const building = new Map<string, Promise<unknown>>();

/** Starts (or joins) today's build of `board`, storing it once done. */
function startBuild<T>(board: string, date: string, build: () => Promise<T>): Promise<T> {
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

/**
 * Today's frozen copy of `board`, built with `build` the first time it's asked for each UTC day.
 *
 * Never makes a visitor wait on (or fail because of) a rebuild when an older copy exists: on a
 * new day the last stored copy is served straight away and today's is built in the background.
 * Big boards (all-time voice across every server) can take longer than the site's request
 * budget to aggregate, which used to show the board as "unavailable" until a build finished,
 * and a failed build showed nothing at all. Only the very first build of a board is awaited.
 * Serving yesterday's copy for a moment is still a frozen, never-live view.
 */
export async function frozenDaily<T>(board: string, build: () => Promise<T>, now = new Date()): Promise<T> {
  const date = utcDate(now);
  const hit = memo.get(board);
  if (hit?.date === date) return hit.value as T;

  const stored = getDb().select().from(globalBoardSnapshots).where(eq(globalBoardSnapshots.board, board)).get();
  let storedValue: T | undefined;
  if (stored) {
    try {
      storedValue = JSON.parse(stored.payload) as T;
    } catch {
      storedValue = undefined; // unreadable: treat as missing
    }
  }
  if (storedValue !== undefined && stored?.snapshotDate === date) {
    memo.set(board, { date, value: storedValue });
    return storedValue;
  }

  if (storedValue !== undefined) {
    // An older copy: serve it now, refresh behind it. A failed refresh keeps the old copy and is
    // retried by the next request.
    startBuild(board, date, build).catch((error: unknown) => {
      log.warn(`[boards] rebuilding the ${board} board failed; still serving the last copy:`, error);
    });
    return storedValue;
  }

  return startBuild(board, date, build);
}

/** Tests only. */
export function resetFrozenBoardMemo(): void {
  memo.clear();
}
