import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { customEvents } from "../../../db/schema.js";

export type CustomEventConfig = {
  channels?: string[];
  match?: string;
  regex?: boolean;
  case_sensitive?: boolean;
};

export type CustomEventRecord = {
  id: number;
  guildId: string;
  name: string;
  triggerType: string;
  config: CustomEventConfig;
  response: string;
  enabled: boolean;
};

function parseConfig(raw: string): CustomEventConfig {
  try {
    return JSON.parse(raw) as CustomEventConfig;
  } catch {
    return {};
  }
}

function rowToRecord(row: typeof customEvents.$inferSelect): CustomEventRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    triggerType: row.triggerType,
    config: parseConfig(row.config),
    response: row.response,
    enabled: row.enabled,
  };
}

export async function createCustomEvent(input: {
  guildId: string;
  name: string;
  triggerType: string;
  config: CustomEventConfig;
  response: string;
}): Promise<CustomEventRecord> {
  const db = getDb();
  const row = await db
    .insert(customEvents)
    .values({
      guildId: input.guildId,
      name: input.name.toLowerCase(),
      triggerType: input.triggerType,
      config: JSON.stringify(input.config),
      response: input.response,
      enabled: true,
    })
    .returning()
    .get();
  return rowToRecord(row);
}

export async function deleteCustomEvent(guildId: string, name: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .delete(customEvents)
    .where(and(eq(customEvents.guildId, guildId), eq(customEvents.name, name.toLowerCase())))
    .returning()
    .get();
  return Boolean(result);
}

export async function listCustomEvents(guildId: string): Promise<CustomEventRecord[]> {
  const db = getDb();
  const rows = await db.select().from(customEvents).where(eq(customEvents.guildId, guildId));
  return rows.map(rowToRecord);
}

export async function getEnabledMessageEvents(guildId: string): Promise<CustomEventRecord[]> {
  const rows = await listCustomEvents(guildId);
  return rows.filter((row) => row.enabled && row.triggerType === "message");
}

export function parseEventConfigJson(raw: string): CustomEventConfig {
  try {
    return JSON.parse(raw) as CustomEventConfig;
  } catch {
    throw new Error("Invalid JSON config");
  }
}
