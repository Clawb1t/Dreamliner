import { and, eq, notInArray } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { counters } from "../../../db/schema.js";

export type CounterRow = {
  guildId: string;
  name: string;
  channelId: string;
  messageId: string | null;
  value: number;
  lastRenamedAt: number | null;
};

export function normalizeCounterName(name: string): string {
  return name.trim().toLowerCase();
}

export async function getCounterRow(guildId: string, name: string): Promise<CounterRow | null> {
  const row = await getDb()
    .select()
    .from(counters)
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))))
    .get();
  return row ?? null;
}

export async function listCounterRows(guildId: string): Promise<CounterRow[]> {
  return getDb().select().from(counters).where(eq(counters.guildId, guildId)).all();
}

/** Insert a row for a counter the config now defines but the DB doesn't track yet. */
export async function ensureCounterRow(input: {
  guildId: string;
  name: string;
  channelId: string;
  value: number;
}): Promise<CounterRow> {
  const row = await getDb()
    .insert(counters)
    .values({
      guildId: input.guildId,
      name: normalizeCounterName(input.name),
      channelId: input.channelId,
      value: input.value,
    })
    .returning()
    .get();
  return row;
}

export async function updateCounterValue(guildId: string, name: string, value: number): Promise<void> {
  await getDb()
    .update(counters)
    .set({ value })
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))));
}

export async function setCounterChannelId(guildId: string, name: string, channelId: string): Promise<void> {
  await getDb()
    .update(counters)
    .set({ channelId })
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))));
}

export async function setCounterMessageId(guildId: string, name: string, messageId: string): Promise<void> {
  await getDb()
    .update(counters)
    .set({ messageId })
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))));
}

export async function setCounterLastRenamedAt(guildId: string, name: string, at: number): Promise<void> {
  await getDb()
    .update(counters)
    .set({ lastRenamedAt: at })
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))));
}

export async function deleteCounterRow(guildId: string, name: string): Promise<void> {
  await getDb()
    .delete(counters)
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))));
}

/** Drop tracked rows for counters no longer present in config (renamed/deleted from the dashboard). */
export async function pruneCounterRows(guildId: string, keepNames: string[]): Promise<CounterRow[]> {
  const normalized = keepNames.map(normalizeCounterName);
  const stale =
    normalized.length > 0
      ? await getDb()
          .select()
          .from(counters)
          .where(and(eq(counters.guildId, guildId), notInArray(counters.name, normalized)))
          .all()
      : await listCounterRows(guildId);

  if (stale.length === 0) return [];

  await getDb()
    .delete(counters)
    .where(
      normalized.length > 0
        ? and(eq(counters.guildId, guildId), notInArray(counters.name, normalized))
        : eq(counters.guildId, guildId),
    );

  return stale;
}
