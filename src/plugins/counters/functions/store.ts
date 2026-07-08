import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { counters } from "../../../db/schema.js";

export type CounterRow = {
  guildId: string;
  name: string;
  channelId: string;
  messageId: string | null;
  value: number;
  counterType: string;
};

export function normalizeCounterName(name: string): string {
  return name.trim().toLowerCase();
}

export async function getCounter(guildId: string, name: string): Promise<CounterRow | null> {
  const row = await getDb()
    .select()
    .from(counters)
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))))
    .get();
  return row ?? null;
}

export async function listCounters(guildId: string): Promise<CounterRow[]> {
  return getDb().select().from(counters).where(eq(counters.guildId, guildId)).all();
}

export async function createCounter(input: {
  guildId: string;
  name: string;
  channelId: string;
  counterType: string;
  value: number;
  messageId?: string | null;
}): Promise<CounterRow> {
  const row = await getDb()
    .insert(counters)
    .values({
      guildId: input.guildId,
      name: normalizeCounterName(input.name),
      channelId: input.channelId,
      counterType: input.counterType,
      value: input.value,
      messageId: input.messageId ?? null,
    })
    .returning()
    .get();
  return row;
}

export async function updateCounterValue(guildId: string, name: string, value: number): Promise<boolean> {
  const result = await getDb()
    .update(counters)
    .set({ value })
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))))
    .returning()
    .get();
  return Boolean(result);
}

export async function setCounterMessageId(guildId: string, name: string, messageId: string): Promise<void> {
  await getDb()
    .update(counters)
    .set({ messageId })
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))));
}

export async function deleteCounter(guildId: string, name: string): Promise<boolean> {
  const result = await getDb()
    .delete(counters)
    .where(and(eq(counters.guildId, guildId), eq(counters.name, normalizeCounterName(name))))
    .returning()
    .get();
  return Boolean(result);
}

export async function getCountersByType(guildId: string, counterType: string): Promise<CounterRow[]> {
  return getDb()
    .select()
    .from(counters)
    .where(and(eq(counters.guildId, guildId), eq(counters.counterType, counterType)))
    .all();
}
