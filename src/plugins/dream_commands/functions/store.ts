import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { dreamCommands } from "../../../db/schema.js";

export type DreamTriggerType = "prefix" | "slash";

export type DreamCommandRow = {
  guildId: string;
  name: string;
  source: string;
  triggerType: DreamTriggerType;
  minLevel: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  enabled: boolean;
};

export const MAX_SLASH_DREAM_COMMANDS = 10;

export function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase();
}

const NAME_RE = /^[a-z0-9_]{1,32}$/;

export function isValidCommandName(name: string): boolean {
  return NAME_RE.test(normalizeCommandName(name));
}

export function normalizeTriggerType(value: string | null | undefined): DreamTriggerType {
  // Legacy "prefix" rows may still exist in the DB (disabled); only "slash" is active.
  return value === "slash" ? "slash" : "prefix";
}

function mapRow(row: typeof dreamCommands.$inferSelect): DreamCommandRow {
  return {
    guildId: row.guildId,
    name: row.name,
    source: row.source,
    triggerType: normalizeTriggerType(row.triggerType),
    minLevel: row.minLevel,
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

export async function listSlashDreamCommands(guildId: string): Promise<DreamCommandRow[]> {
  const rows = await listDreamCommands(guildId);
  return rows.filter((row) => row.triggerType === "slash" && row.enabled);
}

export async function countSlashDreamCommands(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(dreamCommands)
    .where(and(eq(dreamCommands.guildId, guildId), eq(dreamCommands.triggerType, "slash")))
    .get();
  return Number(row?.count ?? 0);
}

export async function createDreamCommand(input: {
  guildId: string;
  name: string;
  source: string;
  triggerType: DreamTriggerType;
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
      triggerType: input.triggerType,
      minLevel: input.minLevel,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      enabled: true,
    })
    .returning()
    .get();
  return mapRow(row);
}

export async function updateDreamCommandSource(
  guildId: string,
  name: string,
  source: string,
  triggerType?: DreamTriggerType,
): Promise<DreamCommandRow | null> {
  return updateDreamCommand(guildId, name, { source, triggerType });
}

export async function updateDreamCommand(
  guildId: string,
  name: string,
  patch: {
    source?: string;
    minLevel?: number;
    triggerType?: DreamTriggerType;
  },
): Promise<DreamCommandRow | null> {
  const row = await getDb()
    .update(dreamCommands)
    .set({
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.minLevel !== undefined ? { minLevel: patch.minLevel } : {}),
      ...(patch.triggerType !== undefined ? { triggerType: patch.triggerType } : {}),
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
