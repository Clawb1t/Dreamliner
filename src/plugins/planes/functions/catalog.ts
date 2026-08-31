import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardTypes } from "../../../db/schema.js";

export const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type Rarity = (typeof RARITY_ORDER)[number];

export function isRarity(value: string): value is Rarity {
  return (RARITY_ORDER as readonly string[]).includes(value);
}

export const RARITY_META: Record<Rarity, { label: string; color: number; weight: number }> = {
  common: { label: "Common", color: 0x9aa4b2, weight: 55 },
  uncommon: { label: "Uncommon", color: 0x3ba55d, weight: 27 },
  rare: { label: "Rare", color: 0x3b82f6, weight: 12 },
  epic: { label: "Epic", color: 0x9b59b6, weight: 5 },
  legendary: { label: "Legendary", color: 0xf1c40f, weight: 1 },
};

/** Descending rarity, common last; used to sort catalog/inventory listings so the good stuff is up top. */
function rarityRank(rarity: string): number {
  const idx = RARITY_ORDER.indexOf(rarity as Rarity);
  return idx === -1 ? -1 : idx;
}

export const CARD_TYPES = ["plane", "airline"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export function isCardType(value: string): value is CardType {
  return (CARD_TYPES as readonly string[]).includes(value);
}

export const CARD_TYPE_META: Record<CardType, { label: string }> = {
  plane: { label: "Plane" },
  airline: { label: "Airline" },
};

export type PlaneTypeRow = typeof planeCardTypes.$inferSelect;

function now() {
  return new Date();
}

export function normalizePlaneKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getPlaneTypeByKey(key: string): PlaneTypeRow | null {
  return getDb().select().from(planeCardTypes).where(eq(planeCardTypes.key, normalizePlaneKey(key))).get() ?? null;
}

export function getPlaneTypeById(id: number): PlaneTypeRow | null {
  return getDb().select().from(planeCardTypes).where(eq(planeCardTypes.id, id)).get() ?? null;
}

export function getPlaneTypesByIds(ids: number[]): PlaneTypeRow[] {
  if (ids.length === 0) return [];
  return getDb().select().from(planeCardTypes).where(inArray(planeCardTypes.id, ids)).all();
}

export function listPlaneTypes(opts: { enabledOnly?: boolean; rarity?: Rarity; cardType?: CardType } = {}): PlaneTypeRow[] {
  const db = getDb();
  const conditions = [];
  if (opts.enabledOnly) conditions.push(eq(planeCardTypes.enabled, true));
  if (opts.rarity) conditions.push(eq(planeCardTypes.rarity, opts.rarity));
  if (opts.cardType) conditions.push(eq(planeCardTypes.cardType, opts.cardType));
  const rows =
    conditions.length > 0
      ? db.select().from(planeCardTypes).where(and(...conditions)).orderBy(asc(planeCardTypes.name)).all()
      : db.select().from(planeCardTypes).orderBy(asc(planeCardTypes.name)).all();
  return [...rows].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || a.name.localeCompare(b.name));
}

/** Key/name search for autocomplete. */
export function searchPlaneTypes(query: string, limit = 25, opts: { enabledOnly?: boolean; ownedBy?: Set<number> } = {}): PlaneTypeRow[] {
  const rows = listPlaneTypes({ enabledOnly: opts.enabledOnly });
  const q = query.trim().toLowerCase();
  let filtered = q ? rows.filter((r) => r.key.includes(q) || r.name.toLowerCase().includes(q)) : rows;
  if (opts.ownedBy) filtered = filtered.filter((r) => opts.ownedBy!.has(r.id));
  return filtered.slice(0, limit);
}

export class CatalogError extends Error {
  constructor(
    message: string,
    public code: "duplicate_key" | "not_found" | "invalid" = "invalid",
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

export type CreatePlaneTypeInput = {
  key: string;
  name: string;
  cardType: CardType;
  subtitle: string;
  rarity: Rarity;
  safety: number;
  imageKey: string;
  createdBy: string;
} & (
  | { cardType: "plane"; speed: number; agility: number; passengerCount: number }
  | { cardType: "airline"; reputation: number; fleetSize: number; destinations: number }
);

const PLANE_STAT_DEFAULTS = { speed: 50, agility: 50, passengerCount: 0 };
const AIRLINE_STAT_DEFAULTS = { reputation: 50, fleetSize: 0, destinations: 0 };

export function createPlaneType(input: CreatePlaneTypeInput): PlaneTypeRow {
  const key = normalizePlaneKey(input.key);
  if (!key) throw new CatalogError("Key must contain at least one letter or number.", "invalid");
  if (getPlaneTypeByKey(key)) throw new CatalogError(`A card with key \`${key}\` already exists.`, "duplicate_key");

  const timestamp = now();
  const db = getDb();
  const stats =
    input.cardType === "plane"
      ? { ...AIRLINE_STAT_DEFAULTS, speed: input.speed, agility: input.agility, passengerCount: input.passengerCount }
      : { ...PLANE_STAT_DEFAULTS, reputation: input.reputation, fleetSize: input.fleetSize, destinations: input.destinations };

  db.insert(planeCardTypes)
    .values({
      key,
      name: input.name.trim(),
      cardType: input.cardType,
      subtitle: input.subtitle.trim(),
      rarity: input.rarity,
      safety: input.safety,
      ...stats,
      imageKey: input.imageKey.trim(),
      enabled: true,
      createdBy: input.createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return getPlaneTypeByKey(key)!;
}

export type UpdatePlaneTypeInput = Partial<{
  name: string;
  subtitle: string;
  rarity: Rarity;
  safety: number;
  speed: number;
  agility: number;
  passengerCount: number;
  reputation: number;
  fleetSize: number;
  destinations: number;
  imageKey: string;
  enabled: boolean;
}>;

export function updatePlaneType(id: number, patch: UpdatePlaneTypeInput): PlaneTypeRow {
  const existing = getPlaneTypeById(id);
  if (!existing) throw new CatalogError("That card doesn't exist.", "not_found");
  getDb()
    .update(planeCardTypes)
    .set({ ...patch, updatedAt: now() })
    .where(eq(planeCardTypes.id, id))
    .run();
  return getPlaneTypeById(id)!;
}

/** Soft-remove: disables the card so it stops appearing in packs/catalog browsing, without
 *  breaking existing inventory rows that already reference it. */
export function disablePlaneType(id: number): PlaneTypeRow {
  return updatePlaneType(id, { enabled: false });
}
