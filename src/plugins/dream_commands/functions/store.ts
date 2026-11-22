import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { dreamCommands } from "../../../db/schema.js";
import { parseStoredProgram } from "../engine/legacy.js";
import type { CommandProgram } from "../engine/types.js";

export type CommandHealth = { status: "needs_resave"; message: string; missing: string[]; at: string } | null;

export type DreamCommandRow = {
  guildId: string;
  name: string;
  program: CommandProgram;
  createdBy: string;
  ownerId: string;
  /** Whose permissions the command runs with. */
  lastEditorId: string;
  createdAt: Date;
  updatedAt: Date;
  enabled: boolean;
  health: CommandHealth;
};

export function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase();
}

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function isValidCommandName(name: string): boolean {
  return NAME_RE.test(normalizeCommandName(name));
}

function parseHealth(raw: string | null): CommandHealth {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CommandHealth;
  } catch {
    return null;
  }
}

function mapRow(row: typeof dreamCommands.$inferSelect): DreamCommandRow {
  return {
    guildId: row.guildId,
    name: row.name,
    program: parseStoredProgram(row.program),
    createdBy: row.createdBy,
    ownerId: row.ownerId ?? row.createdBy,
    lastEditorId: row.lastEditorId ?? row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    enabled: row.enabled,
    health: parseHealth(row.healthJson),
  };
}

const where = (guildId: string, name: string) => and(eq(dreamCommands.guildId, guildId), eq(dreamCommands.name, normalizeCommandName(name)));

export async function getDreamCommand(guildId: string, name: string): Promise<DreamCommandRow | null> {
  const row = getDb().select().from(dreamCommands).where(where(guildId, name)).get();
  return row ? mapRow(row) : null;
}

export async function listDreamCommands(guildId: string): Promise<DreamCommandRow[]> {
  const rows = getDb().select().from(dreamCommands).where(eq(dreamCommands.guildId, guildId)).all();
  return rows.map(mapRow).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.name.localeCompare(b.name));
}

export async function listEnabledDreamCommands(guildId: string): Promise<DreamCommandRow[]> {
  return (await listDreamCommands(guildId)).filter((row) => row.enabled);
}

export async function countDreamCommands(guildId: string): Promise<number> {
  const row = getDb().select({ count: sql<number>`count(*)` }).from(dreamCommands).where(eq(dreamCommands.guildId, guildId)).get();
  return Number(row?.count ?? 0);
}

export async function createDreamCommand(input: { guildId: string; name: string; program: CommandProgram; createdBy: string; enabled?: boolean }): Promise<DreamCommandRow> {
  const now = new Date();
  const row = getDb()
    .insert(dreamCommands)
    .values({
      guildId: input.guildId,
      name: normalizeCommandName(input.name),
      program: JSON.stringify(input.program),
      createdBy: input.createdBy,
      ownerId: input.createdBy,
      lastEditorId: input.createdBy,
      createdAt: now,
      updatedAt: now,
      enabled: input.enabled ?? true,
      healthJson: null,
    })
    .returning()
    .get();
  return mapRow(row);
}

export async function updateDreamCommand(
  guildId: string,
  name: string,
  patch: { program?: CommandProgram; enabled?: boolean; editorId?: string; rename?: string },
): Promise<DreamCommandRow | null> {
  const row = getDb()
    .update(dreamCommands)
    .set({
      ...(patch.program !== undefined ? { program: JSON.stringify(patch.program), healthJson: null } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.editorId ? { lastEditorId: patch.editorId } : {}),
      ...(patch.rename ? { name: normalizeCommandName(patch.rename) } : {}),
      updatedAt: new Date(),
    })
    .where(where(guildId, name))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}

/** Flags a command whose builder lost a permission (shown on the dashboard until re-saved). */
export function setCommandHealth(guildId: string, name: string, health: CommandHealth): void {
  getDb()
    .update(dreamCommands)
    .set({ healthJson: health ? JSON.stringify(health) : null })
    .where(where(guildId, name))
    .run();
}

export async function deleteDreamCommand(guildId: string, name: string): Promise<DreamCommandRow | null> {
  const row = getDb().delete(dreamCommands).where(where(guildId, name)).returning().get();
  return row ? mapRow(row) : null;
}
