import {
  CARD_TYPES,
  CatalogError,
  createPlaneType,
  disablePlaneType,
  getPlaneTypeById,
  isCardType,
  isRarity,
  listPlaneTypes,
  updatePlaneType,
  type CardType,
  type PlaneTypeRow,
  type UpdatePlaneTypeInput,
} from "../plugins/planes/functions/catalog.js";
import { isValidImageKey, listPlaneImageFiles, planeImageExists } from "../plugins/planes/functions/images.js";
import { getPackSettings, setPackSettings, type PackSettings } from "../plugins/planes/functions/settings.js";

export { CatalogError, CARD_TYPES, isCardType, isRarity };
export type { CardType, PackSettings };

/**
 * Public, not-per-user card catalog data: used by the website's marketing pages (e.g. the
 * homepage's decorative card stack), as opposed to userPublicProfile.ts's per-user inventory.
 */
export type PlaneCardCatalogEntry = {
  key: string;
  name: string;
  cardType: CardType;
  rarity: string;
  subtitle: string;
  imageKey: string;
};

export function listPublicPlaneCardCatalog(opts: { limit?: number } = {}): PlaneCardCatalogEntry[] {
  const rows = listPlaneTypes({ enabledOnly: true }).filter((r) => r.imageKey);
  const limited = opts.limit ? rows.slice(0, opts.limit) : rows;
  return limited.map((r) => ({
    key: r.key,
    name: r.name,
    cardType: r.cardType as CardType,
    rarity: r.rarity,
    subtitle: r.subtitle,
    imageKey: r.imageKey,
  }));
}

// --- Superuser dashboard admin: full catalog CRUD ---------------------------------

export type PlaneCardAdmin = {
  id: number;
  key: string;
  name: string;
  cardType: CardType;
  subtitle: string;
  rarity: string;
  speed: number;
  agility: number;
  passengerCount: number;
  reputation: number;
  fleetSize: number;
  destinations: number;
  safety: number;
  imageKey: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function toAdminCard(row: PlaneTypeRow): PlaneCardAdmin {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    cardType: row.cardType as CardType,
    subtitle: row.subtitle,
    rarity: row.rarity,
    speed: row.speed,
    agility: row.agility,
    passengerCount: row.passengerCount,
    reputation: row.reputation,
    fleetSize: row.fleetSize,
    destinations: row.destinations,
    safety: row.safety,
    imageKey: row.imageKey,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every card, enabled or not, with every field: for the superuser dashboard's catalog table. */
export function listAdminPlaneCards(): PlaneCardAdmin[] {
  return listPlaneTypes({}).map(toAdminCard);
}

/** File names currently sitting in assets/planes/, for the dashboard's image-key picker. */
export function listPlaneCardImageFiles(): string[] {
  return listPlaneImageFiles();
}

export function getPlaneCardPackSettings(): PackSettings {
  return getPackSettings();
}

export function updatePlaneCardPackSettings(patch: Partial<PackSettings>, updatedBy: string): PackSettings {
  return setPackSettings(patch, updatedBy);
}

function requireValidImageKey(imageKey: unknown): string {
  if (typeof imageKey !== "string" || !isValidImageKey(imageKey)) {
    throw new CatalogError("imageKey must be a plain file name (png/jpg/jpeg/webp/gif).", "invalid");
  }
  if (!planeImageExists(imageKey)) {
    throw new CatalogError(`No file named "${imageKey}" in assets/planes/. Drop it there first.`, "invalid");
  }
  return imageKey;
}

function numberField(value: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new CatalogError(`${name} must be a number.`, "invalid");
  const rounded = Math.round(n);
  if (opts.min !== undefined && rounded < opts.min) throw new CatalogError(`${name} must be at least ${opts.min}.`, "invalid");
  if (opts.max !== undefined && rounded > opts.max) throw new CatalogError(`${name} must be at most ${opts.max}.`, "invalid");
  return rounded;
}

export type CreateAdminPlaneCardInput = {
  key: unknown;
  name: unknown;
  cardType: unknown;
  subtitle: unknown;
  rarity: unknown;
  imageKey: unknown;
  safety: unknown;
  createdBy: string;
  speed?: unknown;
  agility?: unknown;
  passengerCount?: unknown;
  reputation?: unknown;
  fleetSize?: unknown;
  destinations?: unknown;
};

export function createAdminPlaneCard(input: CreateAdminPlaneCardInput): PlaneCardAdmin {
  if (typeof input.key !== "string" || !input.key.trim()) throw new CatalogError("key is required.", "invalid");
  if (typeof input.name !== "string" || !input.name.trim()) throw new CatalogError("name is required.", "invalid");
  const cardTypeRaw = typeof input.cardType === "string" ? input.cardType : "";
  if (!isCardType(cardTypeRaw)) throw new CatalogError('cardType must be "plane" or "airline".', "invalid");
  const rarityRaw = typeof input.rarity === "string" ? input.rarity : "";
  if (!isRarity(rarityRaw)) throw new CatalogError("rarity is invalid.", "invalid");

  const base = {
    key: input.key,
    name: input.name,
    subtitle: typeof input.subtitle === "string" ? input.subtitle.trim() : "",
    rarity: rarityRaw,
    imageKey: requireValidImageKey(input.imageKey),
    createdBy: input.createdBy,
    safety: numberField(input.safety, "safety", { min: 0, max: 100 }),
  };

  const row =
    cardTypeRaw === "plane"
      ? createPlaneType({
          ...base,
          cardType: "plane",
          speed: numberField(input.speed, "speed", { min: 0, max: 100 }),
          agility: numberField(input.agility, "agility", { min: 0, max: 100 }),
          passengerCount: numberField(input.passengerCount, "passengers", { min: 0, max: 1_000_000 }),
        })
      : createPlaneType({
          ...base,
          cardType: "airline",
          reputation: numberField(input.reputation, "reputation", { min: 0, max: 100 }),
          fleetSize: numberField(input.fleetSize, "fleet size", { min: 0, max: 1_000_000 }),
          destinations: numberField(input.destinations, "destinations", { min: 0, max: 1_000_000 }),
        });

  return toAdminCard(row);
}

export type UpdateAdminPlaneCardInput = Partial<{
  name: unknown;
  subtitle: unknown;
  rarity: unknown;
  imageKey: unknown;
  enabled: unknown;
  speed: unknown;
  agility: unknown;
  passengerCount: unknown;
  reputation: unknown;
  fleetSize: unknown;
  destinations: unknown;
  safety: unknown;
}>;

export function updateAdminPlaneCard(id: number, input: UpdateAdminPlaneCardInput): PlaneCardAdmin {
  const existing = getPlaneTypeById(id);
  if (!existing) throw new CatalogError("That card doesn't exist.", "not_found");

  const patch: UpdatePlaneTypeInput = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) throw new CatalogError("name must not be empty.", "invalid");
    patch.name = input.name.trim();
  }
  if (input.subtitle !== undefined) {
    patch.subtitle = typeof input.subtitle === "string" ? input.subtitle.trim() : "";
  }
  if (input.rarity !== undefined) {
    if (typeof input.rarity !== "string" || !isRarity(input.rarity)) throw new CatalogError("rarity is invalid.", "invalid");
    patch.rarity = input.rarity;
  }
  if (input.imageKey !== undefined) {
    patch.imageKey = requireValidImageKey(input.imageKey);
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new CatalogError("enabled must be a boolean.", "invalid");
    patch.enabled = input.enabled;
  }

  const cardType = existing.cardType as CardType;
  if (cardType === "plane") {
    if (input.reputation !== undefined || input.fleetSize !== undefined || input.destinations !== undefined) {
      throw new CatalogError("reputation/fleetSize/destinations only apply to airline cards.", "invalid");
    }
    if (input.speed !== undefined) patch.speed = numberField(input.speed, "speed", { min: 0, max: 100 });
    if (input.agility !== undefined) patch.agility = numberField(input.agility, "agility", { min: 0, max: 100 });
    if (input.passengerCount !== undefined) {
      patch.passengerCount = numberField(input.passengerCount, "passengers", { min: 0, max: 1_000_000 });
    }
  } else {
    if (input.speed !== undefined || input.agility !== undefined || input.passengerCount !== undefined) {
      throw new CatalogError("speed/agility/passengerCount only apply to plane cards.", "invalid");
    }
    if (input.reputation !== undefined) patch.reputation = numberField(input.reputation, "reputation", { min: 0, max: 100 });
    if (input.fleetSize !== undefined) patch.fleetSize = numberField(input.fleetSize, "fleet size", { min: 0, max: 1_000_000 });
    if (input.destinations !== undefined) {
      patch.destinations = numberField(input.destinations, "destinations", { min: 0, max: 1_000_000 });
    }
  }
  if (input.safety !== undefined) patch.safety = numberField(input.safety, "safety", { min: 0, max: 100 });

  return toAdminCard(updatePlaneType(id, patch));
}

/** Soft-remove: disables the card so it stops appearing in packs/catalog browsing, without
 *  breaking existing inventory rows that already reference it. */
export function disableAdminPlaneCard(id: number): PlaneCardAdmin {
  const existing = getPlaneTypeById(id);
  if (!existing) throw new CatalogError("That card doesn't exist.", "not_found");
  return toAdminCard(disablePlaneType(id));
}
