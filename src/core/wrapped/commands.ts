/**
 * Per-user command counts for Dreamliner Wrapped ("your most used commands"). The existing
 * command_usage_* tables are per server only. Batched like the emoji tally: counted in memory and
 * flushed every few seconds in one transaction.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { wrappedCommandUsage } from "../../db/schema.js";
import { getLogger } from "../logger.js";
import { wrappedYearOf } from "./window.js";

const log = getLogger("wrapped");
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_AT_ENTRIES = 300;

type Pending = { userId: string; year: number; name: string; uses: number };
const pending = new Map<string, Pending>();
let timer: ReturnType<typeof setInterval> | null = null;

export function recordCommandUse(userId: string | null | undefined, commandName: string, at: Date | number = Date.now()): void {
  if (!userId || !commandName) return;
  const name = commandName.trim().toLowerCase().slice(0, 64);
  if (!name) return;
  const year = wrappedYearOf(at);
  const key = `${userId}\u0000${year}\u0000${name}`;
  const entry = pending.get(key);
  if (entry) entry.uses += 1;
  else pending.set(key, { userId, year, name, uses: 1 });
  if (pending.size >= FLUSH_AT_ENTRIES) {
    flushCommandUsage();
    return;
  }
  if (!timer) {
    timer = setInterval(() => flushCommandUsage(), FLUSH_INTERVAL_MS);
    timer.unref?.();
  }
}

export function flushCommandUsage(): number {
  if (pending.size === 0) return 0;
  const batch = [...pending.values()];
  pending.clear();
  try {
    getDb().transaction((tx) => {
      for (const row of batch) {
        tx.insert(wrappedCommandUsage)
          .values({ userId: row.userId, year: row.year, commandName: row.name, uses: row.uses })
          .onConflictDoUpdate({
            target: [wrappedCommandUsage.userId, wrappedCommandUsage.year, wrappedCommandUsage.commandName],
            set: { uses: sql`${wrappedCommandUsage.uses} + ${row.uses}` },
          })
          .run();
      }
    });
    return batch.length;
  } catch (error) {
    log.warn(`Failed to write ${batch.length} command counts: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
}

export function dropPendingCommandsFor(userId: string): void {
  for (const [key, entry] of pending) if (entry.userId === userId) pending.delete(key);
}
