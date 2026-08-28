import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { dreamCommands } from "../../../db/schema.js";
import type { CommandProgram } from "./program.js";

export type DreamCommandRow = {
  guildId: string;
  name: string;
  program: CommandProgram;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  enabled: boolean;
};

export const MAX_DREAM_COMMANDS = 10;

export function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase();
}

const NAME_RE = /^[a-z0-9_]{1,32}$/;

export function isValidCommandName(name: string): boolean {
  return NAME_RE.test(normalizeCommandName(name));
}

function mapRow(row: typeof dreamCommands.$inferSelect): DreamCommandRow {
  return {
    guildId: row.guildId,
    name: row.name,
    program: JSON.parse(row.program) as CommandProgram,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    enabled: row.enabled,
  };
}

export async function getDreamCommand(guildId: string, name: string): Promise<DreamCommandRow | null> {
  const row = await getDb()
    .select()
    .from(dreamCommands)
    .where(and(eq(dreamCommands.guildId, guildId), eq(dreamCommands.name, normalizeCommandName(name))))
    .get();
  return row ? mapRow(row) : null;
}

export async function listDreamCommands(guildId: string): Promise<DreamCommandRow[]> {
  const rows = await getDb().select().from(dreamCommands).where(eq(dreamCommands.guildId, guildId)).all();
  return rows.map(mapRow);
}

export async function listEnabledDreamCommands(guildId: string): Promise<DreamCommandRow[]> {
  const rows = await listDreamCommands(guildId);
  return rows.filter((row) => row.enabled);
}

export async function countDreamCommands(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(dreamCommands)
    .where(eq(dreamCommands.guildId, guildId))
    .get();
  return Number(row?.count ?? 0);
}

export async function createDreamCommand(input: {
  guildId: string;
  name: string;
  program: CommandProgram;
  createdBy: string;
}): Promise<DreamCommandRow> {
  const name = normalizeCommandName(input.name);
  const now = new Date();
  const row = await getDb()
    .insert(dreamCommands)
    .values({
      guildId: input.guildId,
      name,
      program: JSON.stringify(input.program),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      enabled: true,
    })
    .returning()
    .get();
  return mapRow(row);
}

export async function updateDreamCommand(
  guildId: string,
  name: string,
  patch: {
    program?: CommandProgram;
    enabled?: boolean;
  },
): Promise<DreamCommandRow | null> {
  const row = await getDb()
    .update(dreamCommands)
    .set({
      ...(patch.program !== undefined ? { program: JSON.stringify(patch.program) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(dreamCommands.guildId, guildId), eq(dreamCommands.name, normalizeCommandName(name))))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}

export async function deleteDreamCommand(guildId: string, name: string): Promise<DreamCommandRow | null> {
  const row = await getDb()
    .delete(dreamCommands)
    .where(and(eq(dreamCommands.guildId, guildId), eq(dreamCommands.name, normalizeCommandName(name))))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}
