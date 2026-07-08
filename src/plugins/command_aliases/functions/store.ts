import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { commandAliases } from "../../../db/schema.js";

export type CommandAliasRecord = {
  guildId: string;
  name: string;
  command: string;
  options: Record<string, unknown>;
};

function parseOptions(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rowToRecord(row: typeof commandAliases.$inferSelect): CommandAliasRecord {
  return {
    guildId: row.guildId,
    name: row.name,
    command: row.command,
    options: parseOptions(row.options),
  };
}

export async function createCommandAlias(input: {
  guildId: string;
  name: string;
  command: string;
  options?: Record<string, unknown>;
}): Promise<CommandAliasRecord> {
  const db = getDb();
  const row = await db
    .insert(commandAliases)
    .values({
      guildId: input.guildId,
      name: input.name.toLowerCase(),
      command: input.command,
      options: JSON.stringify(input.options ?? {}),
    })
    .onConflictDoUpdate({
      target: [commandAliases.guildId, commandAliases.name],
      set: {
        command: input.command,
        options: JSON.stringify(input.options ?? {}),
      },
    })
    .returning()
    .get();
  return rowToRecord(row);
}

export async function deleteCommandAlias(guildId: string, name: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .delete(commandAliases)
    .where(and(eq(commandAliases.guildId, guildId), eq(commandAliases.name, name.toLowerCase())))
    .returning()
    .get();
  return Boolean(result);
}

export async function listCommandAliases(guildId: string): Promise<CommandAliasRecord[]> {
  const db = getDb();
  const rows = await db.select().from(commandAliases).where(eq(commandAliases.guildId, guildId));
  return rows.map(rowToRecord);
}

export async function getCommandAlias(guildId: string, name: string): Promise<CommandAliasRecord | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(commandAliases)
    .where(and(eq(commandAliases.guildId, guildId), eq(commandAliases.name, name.toLowerCase())))
    .get();
  return row ? rowToRecord(row) : null;
}

export function parseAliasOptionsJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Options must be a JSON object");
    }
    return parsed;
  } catch {
    throw new Error("Invalid JSON options");
  }
}
