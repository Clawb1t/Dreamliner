import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardPacks, planeCardSetCompletions, planeCardSetMembers, planeCardSets, planeCardTypes } from "../../../db/schema.js";
import { normalizePlaneKey } from "../functions/catalog.js";
import { hangarError } from "./errors.js";

export type SetRow = typeof planeCardSets.$inferSelect;
export type SetWithMembers = SetRow & { cardTypeIds: number[] };

export function listSets(opts: { enabledOnly?: boolean } = {}): SetWithMembers[] {
  const db = getDb();
  const sets = db.select().from(planeCardSets).orderBy(asc(planeCardSets.name)).all();
  const members = db.select().from(planeCardSetMembers).all();
  const bySet = new Map<number, number[]>();
  for (const m of members) {
    const list = bySet.get(m.setId) ?? [];
    list.push(m.cardTypeId);
    bySet.set(m.setId, list);
  }
  return sets
    .filter((s) => !opts.enabledOnly || s.enabled)
    .map((s) => ({ ...s, cardTypeIds: (bySet.get(s.id) ?? []).sort((a, b) => a - b) }));
}

export function getSet(id: number): SetWithMembers | null {
  return listSets().find((s) => s.id === id) ?? null;
}

export function getSetByKey(key: string): SetWithMembers | null {
  return listSets().find((s) => s.key === key) ?? null;
}

/** card type id -> ids of every set it belongs to. */
export function setIdsByCardType(sets: SetWithMembers[] = listSets()): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const set of sets) {
    for (const id of set.cardTypeIds) {
      const list = out.get(id) ?? [];
      list.push(set.id);
      out.set(id, list);
    }
  }
  return out;
}

/** A set counts as complete when it has members and the user owns at least one copy of each. */
export function isSetComplete(set: SetWithMembers, ownedTypeIds: Set<number>): boolean {
  return set.cardTypeIds.length > 0 && set.cardTypeIds.every((id) => ownedTypeIds.has(id));
}

export function listUserCompletions(userId: string): Map<number, Date> {
  const rows = getDb().select().from(planeCardSetCompletions).where(eq(planeCardSetCompletions.userId, userId)).all();
  return new Map(rows.map((r) => [r.setId, r.completedAt]));
}

// ── Admin ────────────────────────────────────────────────────────────────────

export type SetInput = {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  bonusParts?: unknown;
  enabled?: unknown;
  cardTypeIds?: unknown;
};

function parseCardTypeIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw hangarError("invalid", "cardTypeIds must be an array of card ids.");
  const ids = [...new Set(raw.map((v) => Number(v)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw hangarError("invalid", "cardTypeIds must be an array of card ids.");
  if (ids.length > 200) throw hangarError("invalid", "A set can have at most 200 cards.");
  const known = new Set(getDb().select({ id: planeCardTypes.id }).from(planeCardTypes).all().map((r) => r.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw hangarError("invalid", "Unknown card ids: {ids}.", { ids: missing.join(", ") });
  return ids;
}

function parseBonus(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0 || n > 100_000) throw hangarError("invalid", "bonusParts must be between 0 and 100000.");
  return n;
}

function replaceMembers(setId: number, ids: number[]): void {
  const db = getDb();
  db.delete(planeCardSetMembers).where(eq(planeCardSetMembers.setId, setId)).run();
  for (const cardTypeId of ids) db.insert(planeCardSetMembers).values({ setId, cardTypeId }).run();
}

export function createSet(input: SetInput): SetWithMembers {
  const key = normalizePlaneKey(typeof input.key === "string" ? input.key : "");
  if (!key) throw hangarError("invalid", "key is required.");
  if (typeof input.name !== "string" || !input.name.trim()) throw hangarError("invalid", "name is required.");
  if (getSetByKey(key)) throw hangarError("conflict", "A set with key {key} already exists.", { key });
  const ids = input.cardTypeIds === undefined ? [] : parseCardTypeIds(input.cardTypeIds);
  const now = new Date();
  return getDb().transaction(() => {
    const row = getDb()
      .insert(planeCardSets)
      .values({
        key,
        name: input.name!.toString().trim().slice(0, 80),
        description: typeof input.description === "string" ? input.description.trim().slice(0, 500) : "",
        bonusParts: input.bonusParts === undefined ? 0 : parseBonus(input.bonusParts),
        enabled: input.enabled === undefined ? true : input.enabled === true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: planeCardSets.id })
      .get();
    replaceMembers(row.id, ids);
    return getSet(row.id)!;
  });
}

export function updateSet(id: number, input: SetInput): SetWithMembers {
  const existing = getSet(id);
  if (!existing) throw hangarError("not_found", "That set doesn't exist.");
  const patch: Partial<SetRow> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) throw hangarError("invalid", "name must not be empty.");
    patch.name = input.name.trim().slice(0, 80);
  }
  if (input.description !== undefined) patch.description = typeof input.description === "string" ? input.description.trim().slice(0, 500) : "";
  if (input.bonusParts !== undefined) patch.bonusParts = parseBonus(input.bonusParts);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw hangarError("invalid", "enabled must be a boolean.");
    patch.enabled = input.enabled;
  }
  const ids = input.cardTypeIds === undefined ? null : parseCardTypeIds(input.cardTypeIds);
  return getDb().transaction(() => {
    getDb().update(planeCardSets).set(patch).where(eq(planeCardSets.id, id)).run();
    if (ids) replaceMembers(id, ids);
    return getSet(id)!;
  });
}

/** Deletes a set and its membership rows. Completion records are kept (the bonus was paid). */
export function deleteSet(id: number): void {
  if (!getSet(id)) throw hangarError("not_found", "That set doesn't exist.");
  const featuring = getDb().select({ key: planeCardPacks.key }).from(planeCardPacks).where(eq(planeCardPacks.featuredSetId, id)).all();
  if (featuring.length) throw hangarError("conflict", "Packs feature this set ({packs}). Change them first.", { packs: featuring.map((p) => p.key).join(", ") });
  getDb().transaction(() => {
    getDb().delete(planeCardSetMembers).where(eq(planeCardSetMembers.setId, id)).run();
    getDb().delete(planeCardSets).where(eq(planeCardSets.id, id)).run();
  });
}
