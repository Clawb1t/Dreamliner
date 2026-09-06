import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { globalWatchdogEntries } from "../db/schema.js";

export type GlobalWatchdogEntry = {
  userId: string;
  reason: string;
  evidenceUrl: string | null;
  addedBy: string;
  createdAt: string;
};

function toEntry(row: typeof globalWatchdogEntries.$inferSelect): GlobalWatchdogEntry {
  return {
    userId: row.userId,
    reason: row.reason,
    evidenceUrl: row.evidenceUrl ?? null,
    addedBy: row.addedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listGlobalWatchdogEntries(): Promise<GlobalWatchdogEntry[]> {
  const rows = await getDb().select().from(globalWatchdogEntries).all();
  return rows.map(toEntry).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function addGlobalWatchdogEntry(input: {
  userId: string;
  reason: string;
  evidenceUrl: string | null;
  addedBy: string;
}): Promise<GlobalWatchdogEntry> {
  if (!/^\d{17,20}$/.test(input.userId)) {
    throw new Error("userId must be a valid Discord snowflake.");
  }
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new Error("reason is required.");

  const db = getDb();
  const now = new Date();
  await db
    .insert(globalWatchdogEntries)
    .values({
      userId: input.userId,
      reason,
      evidenceUrl: input.evidenceUrl,
      addedBy: input.addedBy,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: globalWatchdogEntries.userId,
      set: { reason, evidenceUrl: input.evidenceUrl, addedBy: input.addedBy, createdAt: now },
    });

  const row = await db
    .select()
    .from(globalWatchdogEntries)
    .where(eq(globalWatchdogEntries.userId, input.userId))
    .get();
  return toEntry(row!);
}

export async function removeGlobalWatchdogEntry(userId: string): Promise<void> {
  await getDb().delete(globalWatchdogEntries).where(eq(globalWatchdogEntries.userId, userId));
}

const cache = new Map<string, { entry: GlobalWatchdogEntry | null; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

/** Cached briefly. Checked on every member join across every guild with enforcement on. */
export async function checkGlobalWatchdog(userId: string): Promise<GlobalWatchdogEntry | null> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.entry;

  const row = await getDb()
    .select()
    .from(globalWatchdogEntries)
    .where(eq(globalWatchdogEntries.userId, userId))
    .get();
  const entry = row ? toEntry(row) : null;
  cache.set(userId, { entry, expiresAt: Date.now() + CACHE_TTL_MS });
  return entry;
}
