import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { dreamCommands } from "../../../db/schema.js";

export type DreamCommandRow = {
  guildId: string;
  name: string;
  source: string;
  minLevel: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  enabled: boolean;
};

export function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase();
}

const NAME_RE = /^[a-z0-9_]{1,32}$/;

export function isValidCommandName(name: string): boolean {
  return NAME_RE.test(normalizeCommandName(name));
}

export async function getDreamCommand(guildId: string, name: string): Promise<DreamCommandRow | null> {
  const row = await getDb()
    .select()
    .from(dreamCommands)
    .where(and(eq(dreamCommands.guildId, guildId), eq(dreamCommands.name, normalizeCommandName(name))))
    .get();
  return row ?? null;
}

export async function listDreamCommands(guildId: string): Promise<DreamCommandRow[]> {
  return getDb().select().from(dreamCommands).where(eq(dreamCommands.guildId, guildId)).all();
}

export async function createDreamCommand(input: {
  guildId: string;
  name: string;
  source: string;
  minLevel: number;
  createdBy: string;
}): Promise<DreamCommandRow> {
  const name = normalizeCommandName(input.name);
  const now = new Date();
  const row = await getDb()
    .insert(dreamCommands)
    .values({
      guildId: input.guildId,
      name,
      source: input.source,
      minLevel: input.minLevel,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      enabled: true,
    })
    .returning()
    .get();
  return row;
}

export async function deleteDreamCommand(guildId: string, name: string): Promise<boolean> {
  const result = await getDb()
    .delete(dreamCommands)
    .where(and(eq(dreamCommands.guildId, guildId), eq(dreamCommands.name, normalizeCommandName(name))))
    .returning()
    .get();
  return Boolean(result);
}
