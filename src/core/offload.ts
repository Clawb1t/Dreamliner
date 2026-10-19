import { isMainThread, Worker } from "node:worker_threads";
import { getLogger } from "./logger.js";

/**
 * Runs slow database queries on a worker thread.
 *
 * SQLite (better-sqlite3) is synchronous: a query that scans millions of rows blocks the whole
 * process while it runs, so the bot can't answer anything else, including every other website
 * request, which then times out. A function wrapped with `offloaded` runs on a small pool of worker
 * threads instead, each with its own read connection (the database is in WAL mode, so readers don't
 * block the bot's writes), and the main thread just awaits the result.
 *
 * Only for read-only, argument-and-result-is-plain-data functions. The worker finds the function
 * again by module path and export name, so `offloaded` must wrap an *exported* function whose
 * export name equals the name passed here.
 */

const log = getLogger("offload");

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const POOL_SIZE = 2;
const TASK_TIMEOUT_MS = 60_000;
const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";

type Slot = { worker: Worker; pending: Map<number, Pending>; busy: number };
const slots: Slot[] = [];
let nextId = 1;
let disabled = false;
const counters = { onWorker: 0, fellBack: 0 };

/** How many calls ran on a worker vs fell back to the main thread (for tests and diagnostics). */
export function offloadStats(): { onWorker: number; fellBack: number } {
  return { ...counters };
}

function spawn(): Slot | null {
  try {
    const worker = new Worker(new URL(`./offloadWorker.${ext}`, import.meta.url));
    const slot: Slot = { worker, pending: new Map(), busy: 0 };
    worker.on("message", (message: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const entry = slot.pending.get(message.id);
      if (!entry) return;
      slot.pending.delete(message.id);
      slot.busy--;
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(message.error ?? "worker task failed"));
    });
    const fail = (error: Error) => {
      for (const entry of slot.pending.values()) entry.reject(error);
      slot.pending.clear();
      slot.busy = 0;
      const index = slots.indexOf(slot);
      if (index !== -1) slots.splice(index, 1);
    };
    worker.on("error", (error) => {
      log.warn(`worker error: ${error.message}`);
      fail(error);
    });
    worker.on("exit", (code) => fail(new Error(`worker exited with code ${code}`)));
    worker.unref();
    return slot;
  } catch (error) {
    log.warn(`couldn't start a worker thread, running heavy queries on the main thread: ${error instanceof Error ? error.message : error}`);
    disabled = true;
    return null;
  }
}

function pickSlot(): Slot | null {
  if (disabled) return null;
  if (slots.length < POOL_SIZE) {
    const created = spawn();
    if (created) {
      slots.push(created);
      return created;
    }
    return null;
  }
  return slots.reduce((best, slot) => (slot.busy < best.busy ? slot : best));
}

function callWorker(modulePath: string, name: string, args: unknown[]): Promise<unknown> {
  const slot = pickSlot();
  if (!slot) return Promise.reject(new Error("no worker available"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (slot.pending.delete(id)) {
        slot.busy--;
        reject(new Error(`${name} timed out on the worker`));
      }
    }, TASK_TIMEOUT_MS);
    slot.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    slot.busy++;
    slot.worker.postMessage({ id, modulePath, name, args });
  });
}

/**
 * Wraps a read-only async function so that on the main thread it runs on a worker, and inside the
 * worker (or if workers are unavailable) it runs directly. `modulePath` is relative to `src/`
 * without extension, e.g. "plugins/stats/functions/voice".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function offloaded<F extends (...args: any[]) => Promise<any>>(modulePath: string, name: string, impl: F): F {
  const wrapped = (...args: Parameters<F>): ReturnType<F> => {
    if (!isMainThread || disabled || process.env.DISABLE_OFFLOAD === "1") return impl(...args) as ReturnType<F>;
    return callWorker(modulePath, name, args)
      .then((value) => {
        counters.onWorker++;
        return value;
      })
      .catch((error: unknown) => {
      // A worker problem must never take a page down: fall back to running it here.
      counters.fellBack++;
      log.warn(`${name} fell back to the main thread: ${error instanceof Error ? error.message : error}`);
      return impl(...args);
    }) as ReturnType<F>;
  };
  return wrapped as unknown as F;
}

/** For shutdown and tests. */
export async function stopOffloadWorkers(): Promise<void> {
  const all = slots.splice(0);
  await Promise.all(all.map((slot) => slot.worker.terminate()));
}
