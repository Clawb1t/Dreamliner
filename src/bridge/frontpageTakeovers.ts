import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { frontpageTakeovers } from "../db/schema.js";
import {
  parseTakeoverConfig,
  pickActiveTakeover,
  safeParseTakeoverConfig,
  TakeoverConfigError,
  type TakeoverConfig,
} from "./frontpageTakeoverConfig.js";

/** Superuser-built home page hero takeovers (see frontpageTakeoverConfig.ts for the config). */

export type FrontpageTakeover = {
  id: number;
  name: string;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  priority: number;
  /** null when a stored config no longer validates (it's then never shown on the site). */
  config: TakeoverConfig | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/** What the public home page gets: only what it renders. */
export type PublicFrontpageTakeover = {
  id: number;
  updatedAt: string;
  config: TakeoverConfig;
};

export { TakeoverConfigError as FrontpageTakeoverError };

type Row = typeof frontpageTakeovers.$inferSelect;

function readConfig(row: Row): TakeoverConfig | null {
  try {
    return safeParseTakeoverConfig(JSON.parse(row.config));
  } catch {
    return null;
  }
}

function toTakeover(row: Row): FrontpageTakeover {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    priority: row.priority,
    config: readConfig(row),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().slice(0, 80) : "";
  if (!name) throw new TakeoverConfigError("name is required.");
  return name;
}

function parseDate(value: unknown, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) throw new TakeoverConfigError(`${field} is not a valid date.`);
  return date;
}

function parsePriority(value: unknown): number {
  const priority = Number(value);
  if (!Number.isFinite(priority)) throw new TakeoverConfigError("priority must be a number.");
  return Math.max(-1000, Math.min(1000, Math.round(priority)));
}

function checkWindow(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    throw new TakeoverConfigError("endsAt must be after startsAt.");
  }
}

export async function listAdminTakeovers(): Promise<FrontpageTakeover[]> {
  const rows = await getDb()
    .select()
    .from(frontpageTakeovers)
    .orderBy(desc(frontpageTakeovers.priority), desc(frontpageTakeovers.updatedAt))
    .all();
  return rows.map(toTakeover);
}

/** The takeover the home page should show right now, or null for the default hero. */
export async function getActiveTakeover(now = new Date()): Promise<PublicFrontpageTakeover | null> {
  const rows = await getDb().select().from(frontpageTakeovers).where(eq(frontpageTakeovers.enabled, true)).all();
  // A row whose config stopped validating is skipped, so the next one (or the default hero) shows.
  const valid = rows.flatMap((row) => {
    const config = readConfig(row);
    return config ? [{ ...row, parsed: config }] : [];
  });
  const active = pickActiveTakeover(valid, now);
  return active ? { id: active.id, updatedAt: active.updatedAt.toISOString(), config: active.parsed } : null;
}

export type TakeoverInput = {
  name?: unknown;
  enabled?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  priority?: unknown;
  config?: unknown;
};

export async function createAdminTakeover(input: TakeoverInput & { createdBy: string }): Promise<FrontpageTakeover> {
  const name = parseName(input.name);
  const config = parseTakeoverConfig(input.config);
  const startsAt = parseDate(input.startsAt, "startsAt") ?? null;
  const endsAt = parseDate(input.endsAt, "endsAt") ?? null;
  checkWindow(startsAt, endsAt);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new TakeoverConfigError("enabled must be a boolean.");
  }
  const now = new Date();
  const inserted = await getDb()
    .insert(frontpageTakeovers)
    .values({
      name,
      // New takeovers start as drafts unless the caller says otherwise.
      enabled: input.enabled === true,
      startsAt,
      endsAt,
      priority: input.priority === undefined ? 0 : parsePriority(input.priority),
      config: JSON.stringify(config),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toTakeover(inserted);
}

export async function updateAdminTakeover(id: number, input: TakeoverInput): Promise<FrontpageTakeover | null> {
  const existing = await getDb().select().from(frontpageTakeovers).where(eq(frontpageTakeovers.id, id)).get();
  if (!existing) return null;

  const patch: Partial<typeof frontpageTakeovers.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = parseName(input.name);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new TakeoverConfigError("enabled must be a boolean.");
    patch.enabled = input.enabled;
  }
  if (input.priority !== undefined) patch.priority = parsePriority(input.priority);
  if (input.config !== undefined) patch.config = JSON.stringify(parseTakeoverConfig(input.config));

  const startsAt = input.startsAt !== undefined ? parseDate(input.startsAt, "startsAt") ?? null : existing.startsAt;
  const endsAt = input.endsAt !== undefined ? parseDate(input.endsAt, "endsAt") ?? null : existing.endsAt;
  checkWindow(startsAt, endsAt);
  if (input.startsAt !== undefined) patch.startsAt = startsAt;
  if (input.endsAt !== undefined) patch.endsAt = endsAt;

  const updated = await getDb()
    .update(frontpageTakeovers)
    .set(patch)
    .where(eq(frontpageTakeovers.id, id))
    .returning()
    .get();
  return toTakeover(updated);
}

export async function deleteAdminTakeover(id: number): Promise<boolean> {
  const deleted = await getDb().delete(frontpageTakeovers).where(eq(frontpageTakeovers.id, id)).returning().get();
  return Boolean(deleted);
}
