import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  CARD_TYPES,
  CatalogError,
  createPlaneType,
  disablePlaneType,
  getPlaneTypeById,
  isCardType,
  listPlaneTypes,
  updatePlaneType,
  type CardType,
  type PlaneTypeRow,
  type UpdatePlaneTypeInput,
} from "../plugins/economy/functions/catalog.js";
import { PLANE_IMAGES_DIR, isValidImageKey, listPlaneImageFiles, planeImageExists } from "../plugins/economy/functions/images.js";
import { decodeBase64Upload } from "../core/pageAssets.js";
import { loadImageSafe } from "../core/safeImage.js";
import { ART_MAX_DIMENSION, ART_UPLOAD_MAX_BYTES, isRarity } from "../plugins/economy/hangar/constants.js";
import { mintedCounts } from "../plugins/economy/hangar/copies.js";
import { invalidateArt } from "../plugins/economy/hangar/render.js";

export { CatalogError, CARD_TYPES, isCardType, isRarity };
export type { CardType };

/**
 * Public, not-per-user card catalog data: used by the website's marketing pages (e.g. the
 * homepage's decorative card stack), as opposed to userPublicProfile.ts's per-user collection.
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
  printRun: number | null;
  minted: number;
  retiredAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function toAdminCard(row: PlaneTypeRow, minted = mintedCounts()): PlaneCardAdmin {
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
    printRun: row.printRun ?? null,
    minted: minted.get(row.id) ?? 0,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every card, enabled or not, with every field: for the superuser dashboard's catalog table. */
export function listAdminPlaneCards(): PlaneCardAdmin[] {
  const minted = mintedCounts();
  return listPlaneTypes({}).map((row) => toAdminCard(row, minted));
}

/** File names currently sitting in assets/planes/, for the dashboard's image-key picker. */
export function listPlaneCardImageFiles(): string[] {
  return listPlaneImageFiles();
}

/**
 * Saves an uploaded card image (base64 or a data: URL) into assets/planes/ as a PNG and returns
 * its image key. The bytes must decode as a real image (PNG, JPEG, WebP or GIF), at most 4MB;
 * anything larger than ART_MAX_DIMENSION on a side is scaled down.
 */
export async function uploadPlaneCardArt(base64: unknown): Promise<{ imageKey: string; width: number; height: number; bytes: number }> {
  if (typeof base64 !== "string" || !base64.trim()) throw new CatalogError("imageBase64 is required.", "invalid");
  if (/^data:/i.test(base64) && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(base64)) {
    throw new CatalogError("Upload a PNG, JPEG, WebP or GIF image.", "invalid");
  }
  let raw: Buffer;
  try {
    raw = decodeBase64Upload(base64);
  } catch (error) {
    throw new CatalogError(error instanceof Error ? error.message : "Image must be 4MB or smaller.", "invalid");
  }
  if (!raw.length) throw new CatalogError("That upload is empty.", "invalid");
  if (raw.length > ART_UPLOAD_MAX_BYTES) throw new CatalogError("Image must be 4MB or smaller.", "invalid");
  let image: Awaited<ReturnType<typeof loadImageSafe>>;
  try {
    image = await loadImageSafe(raw);
  } catch {
    throw new CatalogError("That file isn't an image we can read. Use PNG, JPEG, WebP or GIF.", "invalid");
  }
  const scale = Math.min(ART_MAX_DIMENSION / image.width, ART_MAX_DIMENSION / image.height, 1);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const png = canvas.toBuffer("image/png");
  const imageKey = `u_${createHash("sha1").update(png).digest("hex").slice(0, 16)}.png`;
  writeFileSync(join(PLANE_IMAGES_DIR, imageKey), png);
  invalidateArt(imageKey);
  return { imageKey, width, height, bytes: png.length };
}

function requireValidImageKey(imageKey: unknown): string {
  if (typeof imageKey !== "string" || !isValidImageKey(imageKey)) {
    throw new CatalogError("imageKey must be a plain file name (png/jpg/jpeg/webp/gif).", "invalid");
  }
  if (!planeImageExists(imageKey)) {
    throw new CatalogError(`No image named "${imageKey}". Upload it first.`, "invalid");
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

function printRunField(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return numberField(value, "printRun", { min: 1, max: 1_000_000 });
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
  printRun?: unknown;
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
    printRun: printRunField(input.printRun),
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
  printRun: unknown;
  retired: unknown;
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
  if (input.printRun !== undefined) {
    const printRun = printRunField(input.printRun);
    const minted = mintedCounts().get(id) ?? 0;
    if (printRun !== null && printRun < minted) {
      throw new CatalogError(`printRun can't be below the ${minted} copies already minted.`, "invalid");
    }
    patch.printRun = printRun;
    // Raising (or removing) the cap un-retires a card that sold out; hitting it exactly retires it.
    if (printRun === null || printRun > minted) {
      if (existing.retiredAt && existing.printRun != null && minted >= existing.printRun) patch.retiredAt = null;
    } else {
      patch.retiredAt = existing.retiredAt ?? new Date();
    }
  }
  if (input.retired !== undefined) {
    if (typeof input.retired !== "boolean") throw new CatalogError("retired must be a boolean.", "invalid");
    patch.retiredAt = input.retired ? (existing.retiredAt ?? new Date()) : null;
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

  const updated = updatePlaneType(id, patch);
  invalidateArt(updated.imageKey);
  return toAdminCard(updated);
}

/** Soft-remove: disables the card so it stops dropping from packs; owned copies are untouched. */
export function disableAdminPlaneCard(id: number): PlaneCardAdmin {
  const existing = getPlaneTypeById(id);
  if (!existing) throw new CatalogError("That card doesn't exist.", "not_found");
  return toAdminCard(disablePlaneType(id));
}
