import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  guildOneSubscriptions,
  storeCreditLedger,
  storeEntitlements,
  storeProducts,
  userCosmeticsEquipped,
} from "../../db/schema.js";
import { STORE_PRICING } from "./pricing.js";
import { creditsForMiles, getStoreSettings } from "./settings.js";
import { getMilesPacks, type MilesPack } from "./miles.js";
import { isCosmeticSlot, type CosmeticSlot, type CosmeticStyle } from "../cosmetics/types.js";
import { parseSlotStyle, resolveSlotStyle, type StoredSlotStyle } from "../cosmetics/schema.js";
import { invalidateAllCosmetics, invalidateUserCosmetics } from "../cosmetics/cache.js";

/**
 * The Dreamliner Store catalog. Products live in the store_products table (managed by platform
 * superusers from the dashboard); each product type has a handler that validates a purchase,
 * prices it and delivers it. Buying is one SQLite transaction: the balance check, the delivery,
 * the ledger charge and the entitlement rows all happen together or not at all.
 *
 * Two currencies: credits (earned by voting) and Miles (bought with real money as Discord
 * consumable purchases). Dreamliner One days are credits only; cosmetics and bundles are priced in
 * Miles, and their credits price is ceil(priceMiles x creditsPerMile) (store_settings).
 */

const DAY_MS = 86_400_000;

/** Same shape as pageAssets ids (kept here so the store core does not load the image stack). */
const ASSET_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export const DREAMLINER_ONE_PRODUCT_ID = "dreamliner-one";

export const PRODUCT_TYPES = ["one_days", "cosmetic", "bundle"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const CURRENCIES = ["credits", "miles"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

export type OneDaysConfig = { dayStep: number; maxDays: number };
export type CosmeticConfig = { slot: CosmeticSlot; style: StoredSlotStyle };
export type BundleConfig = { productIds: string[] };
export type ProductConfigByType = { one_days: OneDaysConfig; cosmetic: CosmeticConfig; bundle: BundleConfig };
export type ProductConfig = ProductConfigByType[ProductType];

export const MAX_BUNDLE_ITEMS = 20;

/**
 * Names of products deleted when animated backgrounds replaced Card Themes and Profile Effects
 * (migration 0127), so purchase and refund history still reads properly.
 */
export const RETIRED_PRODUCT_NAMES: Readonly<Record<string, string>> = {
  "theme-night-sky": "Night Sky",
  "theme-sunset-runway": "Sunset Runway",
  "theme-aurora": "Aurora",
  "theme-clouds": "Above the Clouds",
  "effect-snow": "Snowfall",
  "effect-sparkles": "Sparkles",
  "effect-petals": "Cherry Petals",
  "effect-fireflies": "Fireflies",
  "effect-stars": "Shooting Stars",
};

/** A product's display name, also for retired (deleted) products. */
export function productDisplayName(productId: string): string {
  return getProduct(productId)?.name ?? RETIRED_PRODUCT_NAMES[productId] ?? productId;
}

export type StoreProduct = {
  id: string;
  type: ProductType;
  name: string;
  tagline: string;
  description: string;
  /** one_days: credits per day. cosmetic / bundle: unused (derived from priceMiles). */
  priceCredits: number;
  /** cosmetic / bundle: the Miles price (0 is a free claim). Null for one_days. */
  priceMiles: number | null;
  imageAssetId: string | null;
  heroAssetId: string | null;
  accentColor: number | null;
  badge: string | null;
  section: string;
  featured: boolean;
  sortOrder: number;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  config: ProductConfig;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
};

export function cosmeticConfigOf(product: StoreProduct): CosmeticConfig | null {
  return product.type === "cosmetic" ? (product.config as CosmeticConfig) : null;
}

export function bundleConfigOf(product: StoreProduct): BundleConfig | null {
  return product.type === "bundle" ? (product.config as BundleConfig) : null;
}

export type StorePurchaseErrorCode =
  | "invalid_days"
  | "invalid_input"
  | "insufficient_credits"
  | "insufficient_miles"
  | "already_owned"
  | "wrong_currency"
  | "one_forever"
  | "not_available"
  | "unknown_product"
  | "duplicate_request";

export class StorePurchaseError extends Error {
  constructor(
    readonly code: StorePurchaseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP status for a purchase error, for the bridge. */
export function purchaseErrorStatus(code: StorePurchaseErrorCode): number {
  if (code === "invalid_days" || code === "invalid_input" || code === "wrong_currency") return 400;
  if (code === "unknown_product") return 404;
  return 409;
}

// --- Reading the catalog ---------------------------------------------------------------------

const DEFAULT_ONE_DAYS_CONFIG: OneDaysConfig = {
  dayStep: STORE_PRICING.dayStep,
  maxDays: STORE_PRICING.maxDaysPerPurchase,
};

function parseConfig(type: ProductType, json: string): ProductConfig | null {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Fall back to the defaults below.
  }
  switch (type) {
    case "one_days": {
      const dayStep = isPositiveInt(raw.dayStep) ? raw.dayStep : DEFAULT_ONE_DAYS_CONFIG.dayStep;
      const maxDays = isPositiveInt(raw.maxDays) && raw.maxDays >= dayStep ? raw.maxDays : Math.max(dayStep, DEFAULT_ONE_DAYS_CONFIG.maxDays);
      return { dayStep, maxDays };
    }
    case "cosmetic": {
      if (!isCosmeticSlot(raw.slot)) return null;
      const style = parseSlotStyle(raw.slot, raw.style);
      return style.ok ? { slot: raw.slot, style: style.style } : null;
    }
    case "bundle": {
      const ids = Array.isArray(raw.productIds) ? raw.productIds.filter((id): id is string => typeof id === "string") : [];
      return { productIds: [...new Set(ids)].slice(0, MAX_BUNDLE_ITEMS) };
    }
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isProductType(value: unknown): value is ProductType {
  return typeof value === "string" && (PRODUCT_TYPES as readonly string[]).includes(value);
}

type ProductRow = typeof storeProducts.$inferSelect;

function fromRow(row: ProductRow): StoreProduct | null {
  // A row of a type this build doesn't know (added by a newer build), or a cosmetic whose config no
  // longer validates, is skipped, not crashed on.
  if (!isProductType(row.type)) return null;
  const config = parseConfig(row.type, row.configJson);
  if (!config) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    priceCredits: row.priceCredits,
    priceMiles: row.type === "one_days" ? null : Math.max(0, row.priceMiles ?? 0),
    imageAssetId: row.imageAssetId,
    heroAssetId: row.heroAssetId,
    accentColor: row.accentColor,
    badge: row.badge,
    section: row.section,
    featured: row.featured,
    sortOrder: row.sortOrder,
    active: row.active,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Every uploaded image the catalog still points at (card and hero art, plus any `*AssetId` in a
 * product's config, e.g. frame art and background stills), archived products included. Uploads
 * use it so pruning old files never deletes art a product still shows.
 */
export function referencedStoreAssetIds(): Set<string> {
  const ids = new Set<string>();
  const rows = getDb()
    .select({ image: storeProducts.imageAssetId, hero: storeProducts.heroAssetId, config: storeProducts.configJson })
    .from(storeProducts)
    .all();
  for (const row of rows) {
    if (row.image) ids.add(row.image);
    if (row.hero) ids.add(row.hero);
    for (const match of row.config.matchAll(/"[A-Za-z]*AssetId"\s*:\s*"([a-zA-Z0-9_-]{1,64})"/g)) ids.add(match[1]!);
    // Lists of uploads too (a background's animation frame sheets: `*AssetIds: [...]`).
    for (const list of row.config.matchAll(/"[A-Za-z]*AssetIds"\s*:\s*\[([^\]]*)\]/g)) {
      for (const match of list[1]!.matchAll(/"([a-zA-Z0-9_-]{1,64})"/g)) ids.add(match[1]!);
    }
  }
  return ids;
}

const CACHE_MS = 30_000;
let cache: { at: number; products: StoreProduct[] } | null = null;

/** Drops the cached catalog (after any admin write). */
export function invalidateProductCache(): void {
  cache = null;
  // A cosmetic's style may have changed, so everyone's resolved styles are stale too.
  invalidateAllCosmetics();
}

function compareProducts(a: StoreProduct, b: StoreProduct): number {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

function allProducts(): StoreProduct[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.products;
  const products = getDb()
    .select()
    .from(storeProducts)
    .all()
    .map(fromRow)
    .filter((product): product is StoreProduct => product !== null)
    .sort(compareProducts);
  cache = { at: Date.now(), products };
  return products;
}

/** Products, featured first then by sort order and name. Inactive (archived) ones only on request. */
export function listProducts(options: { includeInactive?: boolean } = {}): StoreProduct[] {
  const products = allProducts();
  return options.includeInactive ? [...products] : products.filter((product) => product.active);
}

export function getProduct(id: string): StoreProduct | null {
  return allProducts().find((product) => product.id === id) ?? null;
}

/** Active and inside its availability window. */
export function isPurchasable(product: StoreProduct, now: Date = new Date()): boolean {
  if (!product.active) return false;
  if (product.startsAt && product.startsAt.getTime() > now.getTime()) return false;
  if (product.endsAt && product.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/** Shown in the public catalog: active, and not ended (upcoming ones show as not yet available). */
export function isListed(product: StoreProduct, now: Date = new Date()): boolean {
  return product.active && !(product.endsAt && product.endsAt.getTime() <= now.getTime());
}

/** A product's price in a currency (one_days: per day, and credits only). Null when it can't be
 *  bought with that currency. */
export function unitPrice(product: StoreProduct, currency: Currency, creditsPerMile = getStoreSettings().creditsPerMile): number | null {
  if (product.type === "one_days") return currency === "credits" ? product.priceCredits : null;
  const miles = product.priceMiles ?? 0;
  return currency === "miles" ? miles : creditsForMiles(miles, creditsPerMile);
}

// --- Product type handlers -------------------------------------------------------------------

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export type Delivery = {
  guildId: string | null;
  days: number | null;
  quantity: number;
  expiresAt: Date | null;
  /** Cosmetics delivered (the item, or a bundle's missing items). */
  grantedProductIds: string[];
};

export type PurchaseContext<Input> = { userId: string; product: StoreProduct; input: Input; now: Date; currency: Currency };

export type ProductHandler<Input> = {
  /** Currencies this type can be bought with; the first is the default. */
  currencies: readonly [Currency, ...Currency[]];
  /** Checks and normalizes the purchase input (throws StorePurchaseError). */
  validate(input: unknown, product: StoreProduct): Input;
  /** Refuses a purchase that can't happen, before the balance is looked at (e.g. already owned). */
  precheck?(tx: Tx, ctx: PurchaseContext<Input>): void;
  /** The price of this purchase, in `currency`. */
  quote(input: Input, product: StoreProduct, pricing: { currency: Currency; creditsPerMile: number }): number;
  /** Delivers the purchase inside the purchase transaction (throws StorePurchaseError to abort). */
  deliver(tx: Tx, ctx: PurchaseContext<Input>): Delivery;
};

export type OneDaysInput = { guildId: string; days: number };
export type NoInput = Record<string, never>;

const oneDaysHandler: ProductHandler<OneDaysInput> = {
  currencies: ["credits"],

  validate(input, product) {
    const config = product.config as OneDaysConfig;
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const days = record.days;
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < config.dayStep ||
      days > config.maxDays ||
      days % config.dayStep !== 0
    ) {
      throw new StorePurchaseError(
        "invalid_days",
        `Pick ${config.dayStep} to ${config.maxDays} days, in steps of ${config.dayStep}.`,
      );
    }
    const guildId = typeof record.guildId === "string" ? record.guildId.trim() : "";
    if (!guildId) throw new StorePurchaseError("invalid_input", "Pick a server to add Dreamliner One to.");
    return { guildId, days };
  },

  quote(input, product) {
    return input.days * product.priceCredits;
  },

  deliver(tx, { userId, input, now }) {
    const row = tx.select().from(guildOneSubscriptions).where(eq(guildOneSubscriptions.guildId, input.guildId)).get();
    const active = row && !row.revokedAt && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime());
    if (active && row.expiresAt === null) {
      throw new StorePurchaseError("one_forever", "This server already has Dreamliner One for good.");
    }

    // Days stack on top of an active grant; an expired or revoked grant starts fresh from now.
    const base = active && row.expiresAt ? row.expiresAt.getTime() : now.getTime();
    const expiresAt = new Date(base + input.days * DAY_MS);

    if (!row) {
      tx.insert(guildOneSubscriptions)
        .values({
          guildId: input.guildId,
          expiresAt,
          note: "Store credits",
          grantedBy: userId,
          grantedAt: now,
          updatedBy: userId,
          updatedAt: now,
          revokedAt: null,
        })
        .run();
    } else if (active) {
      // Extending a live grant keeps who granted it and its note.
      tx.update(guildOneSubscriptions)
        .set({ expiresAt, updatedBy: userId, updatedAt: now })
        .where(eq(guildOneSubscriptions.guildId, input.guildId))
        .run();
    } else {
      tx.update(guildOneSubscriptions)
        .set({
          expiresAt,
          note: "Store credits",
          grantedBy: userId,
          grantedAt: now,
          updatedBy: userId,
          updatedAt: now,
          revokedAt: null,
        })
        .where(eq(guildOneSubscriptions.guildId, input.guildId))
        .run();
    }
    return { guildId: input.guildId, days: input.days, quantity: 1, expiresAt, grantedProductIds: [] };
  },
};

/** Product ids among `productIds` this member already has an entitlement for. */
function ownedAmong(tx: Tx, userId: string, productIds: string[]): Set<string> {
  if (productIds.length === 0) return new Set();
  const rows = tx
    .select({ productId: storeEntitlements.productId })
    .from(storeEntitlements)
    .where(and(eq(storeEntitlements.userId, userId), inArray(storeEntitlements.productId, productIds)))
    .all();
  return new Set(rows.map((row) => row.productId));
}

/** Wears a newly delivered cosmetic when nothing is equipped in its slot yet. */
function autoEquip(tx: Tx, userId: string, slot: CosmeticSlot, productId: string, now: Date): void {
  tx.insert(userCosmeticsEquipped).values({ userId, slot, productId, equippedAt: now }).onConflictDoNothing().run();
}

function noInput(): NoInput {
  return {};
}

function milesQuote(_input: NoInput, product: StoreProduct, pricing: { currency: Currency; creditsPerMile: number }): number {
  return unitPrice(product, pricing.currency, pricing.creditsPerMile) ?? 0;
}

const cosmeticHandler: ProductHandler<NoInput> = {
  currencies: ["miles", "credits"],
  validate: noInput,

  precheck(tx, { userId, product }) {
    if (ownedAmong(tx, userId, [product.id]).size > 0) {
      throw new StorePurchaseError("already_owned", `You already own ${product.name}.`);
    }
  },

  quote: milesQuote,

  deliver(tx, { userId, product, now }) {
    const config = product.config as CosmeticConfig;
    autoEquip(tx, userId, config.slot, product.id, now);
    return { guildId: null, days: null, quantity: 1, expiresAt: null, grantedProductIds: [product.id] };
  },
};

/** A bundle's items that exist as cosmetics, in bundle order. */
function bundleItemRows(tx: Tx, product: StoreProduct): StoreProduct[] {
  const ids = (product.config as BundleConfig).productIds;
  if (ids.length === 0) return [];
  const rows = tx.select().from(storeProducts).where(inArray(storeProducts.id, ids)).all();
  const byId = new Map(
    rows
      .map(fromRow)
      .filter((item): item is StoreProduct => item !== null && item.type === "cosmetic")
      .map((item) => [item.id, item]),
  );
  return ids.map((id) => byId.get(id)).filter((item): item is StoreProduct => Boolean(item));
}

const bundleHandler: ProductHandler<NoInput> = {
  currencies: ["miles", "credits"],
  validate: noInput,

  precheck(tx, { userId, product }) {
    const items = bundleItemRows(tx, product);
    const owned = ownedAmong(tx, userId, items.map((item) => item.id));
    if (items.length === 0 || items.every((item) => owned.has(item.id))) {
      throw new StorePurchaseError("already_owned", `You already own everything in ${product.name}.`);
    }
  },

  quote: milesQuote,

  deliver(tx, { userId, product, now }) {
    const items = bundleItemRows(tx, product);
    const owned = ownedAmong(tx, userId, items.map((item) => item.id));
    const missing = items.filter((item) => !owned.has(item.id));
    for (const item of missing) autoEquip(tx, userId, (item.config as CosmeticConfig).slot, item.id, now);
    return { guildId: null, days: null, quantity: 1, expiresAt: null, grantedProductIds: missing.map((item) => item.id) };
  },
};

type HandlerInput = { one_days: OneDaysInput; cosmetic: NoInput; bundle: NoInput };

/** One handler per product type (a new type will not compile until it has one). */
export const PRODUCT_HANDLERS: { [T in ProductType]: ProductHandler<HandlerInput[T]> } = {
  one_days: oneDaysHandler,
  cosmetic: cosmeticHandler,
  bundle: bundleHandler,
};

// --- Buying ------------------------------------------------------------------------------------

export type PurchaseReceipt = {
  ledgerId: number;
  product: { id: string; name: string };
  /** What was charged, in `currency`. */
  cost: number;
  currency: Currency;
  /** The `currency` balance right after this purchase. */
  balance: number;
  guildId: string | null;
  days: number | null;
  expiresAt: Date | null;
  /** Cosmetics delivered by this purchase (a bundle only delivers the items not owned yet). */
  grantedProductIds: string[];
  /** True when this requestId was already bought, so this is the original receipt (no charge). */
  replayed: boolean;
};

export const MAX_REQUEST_ID_LENGTH = 64;

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/** A member's balance in one currency (optionally only up to a ledger row). */
export function sumBalance(tx: Tx, userId: string, currency: Currency, upToLedgerId?: number): number {
  const base = and(eq(storeCreditLedger.userId, userId), eq(storeCreditLedger.currency, currency));
  const where = upToLedgerId === undefined ? base : and(base, sql`${storeCreditLedger.id} <= ${upToLedgerId}`);
  const row = tx
    .select({ total: sql<number>`coalesce(sum(${storeCreditLedger.delta}), 0)` })
    .from(storeCreditLedger)
    .where(where)
    .get();
  return Number(row?.total ?? 0);
}

function productName(tx: Tx, productId: string): string {
  return tx.select({ name: storeProducts.name }).from(storeProducts).where(eq(storeProducts.id, productId)).get()?.name ?? productId;
}

/** The original receipt of an earlier purchase with this requestId, or null. */
function findReceipt(tx: Tx, userId: string, requestId: string): PurchaseReceipt | null {
  const ledger = tx
    .select()
    .from(storeCreditLedger)
    .where(and(eq(storeCreditLedger.userId, userId), eq(storeCreditLedger.requestId, requestId)))
    .get();
  if (!ledger) return null;
  const productId = ledger.productId ?? DREAMLINER_ONE_PRODUCT_ID;
  const entitlements = tx.select().from(storeEntitlements).where(eq(storeEntitlements.ledgerId, ledger.id)).all();
  const main = entitlements.find((row) => row.productId === productId) ?? entitlements[0];
  const type = tx.select({ type: storeProducts.type }).from(storeProducts).where(eq(storeProducts.id, productId)).get()?.type;
  const currency: Currency = ledger.currency === "miles" ? "miles" : "credits";
  return {
    ledgerId: ledger.id,
    product: { id: productId, name: productName(tx, productId) },
    cost: -ledger.delta,
    currency,
    balance: sumBalance(tx, userId, currency, ledger.id),
    guildId: ledger.guildId,
    days: ledger.days,
    expiresAt: main?.expiresAt ?? null,
    grantedProductIds:
      type === "bundle"
        ? entitlements.filter((row) => row.productId !== productId).map((row) => row.productId)
        : type === "cosmetic"
          ? [productId]
          : [],
    replayed: true,
  };
}

/** An earlier purchase by this member with this requestId, if there was one. */
export function findPurchaseByRequest(userId: string, requestId: string): PurchaseReceipt | null {
  if (!isRequestId(requestId)) return null;
  return getDb().transaction((tx) => findReceipt(tx, userId, requestId));
}

/**
 * Buys a product. With a requestId, a repeat of the same purchase (a double click, a retried
 * request) returns the original receipt instead of charging again; reusing a requestId for a
 * different product throws duplicate_request. `currency` defaults to the product type's own
 * (Miles for cosmetics and bundles, credits for Dreamliner One).
 */
export function purchaseProduct(params: {
  userId: string;
  productId: string;
  input: unknown;
  requestId?: string | null;
  currency?: Currency | null;
  now?: Date;
}): PurchaseReceipt {
  const now = params.now ?? new Date();
  const requestId = params.requestId ?? null;
  if (requestId !== null && !isRequestId(requestId)) {
    throw new StorePurchaseError("invalid_input", `requestId must be 1 to ${MAX_REQUEST_ID_LENGTH} characters.`);
  }
  const creditsPerMile = getStoreSettings().creditsPerMile;

  const receipt = getDb().transaction((tx) => {
    if (requestId) {
      const previous = findReceipt(tx, params.userId, requestId);
      if (previous) {
        if (previous.product.id !== params.productId) {
          throw new StorePurchaseError("duplicate_request", "That purchase request was already used for something else.");
        }
        return previous;
      }
    }

    const row = tx.select().from(storeProducts).where(eq(storeProducts.id, params.productId)).get();
    const product = row ? fromRow(row) : null;
    if (!product) throw new StorePurchaseError("unknown_product", "That product isn't in the store.");
    if (!isPurchasable(product, now)) {
      throw new StorePurchaseError("not_available", `${product.name} isn't available right now.`);
    }

    const handler = PRODUCT_HANDLERS[product.type] as ProductHandler<unknown>;
    const currency = params.currency ?? handler.currencies[0];
    if (!handler.currencies.includes(currency)) {
      throw new StorePurchaseError(
        "wrong_currency",
        product.type === "one_days" ? `${product.name} can only be bought with credits.` : `${product.name} can't be bought with ${currency}.`,
      );
    }
    const input = handler.validate(params.input, product);
    const ctx = { userId: params.userId, product, input, now, currency };
    handler.precheck?.(tx, ctx);
    const cost = handler.quote(input, product, { currency, creditsPerMile });

    const balance = sumBalance(tx, params.userId, currency);
    if (balance < cost) {
      const days = (input as Partial<OneDaysInput>).days;
      if (currency === "miles") {
        throw new StorePurchaseError("insufficient_miles", `You need ${cost} Miles for ${product.name}.`);
      }
      throw new StorePurchaseError(
        "insufficient_credits",
        product.type === "one_days" && typeof days === "number"
          ? `You need ${cost} credits for ${days} days.`
          : `You need ${cost} credits for ${product.name}.`,
      );
    }

    const delivery = handler.deliver(tx, ctx);

    let ledgerId: number;
    try {
      ledgerId = Number(
        tx
          .insert(storeCreditLedger)
          .values({
            userId: params.userId,
            delta: -cost,
            kind: "purchase",
            currency,
            guildId: delivery.guildId,
            days: delivery.days,
            productId: product.id,
            requestId,
            createdAt: now,
          })
          .run().lastInsertRowid,
      );
    } catch (error) {
      if (String((error as { code?: unknown })?.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
        throw new StorePurchaseError("duplicate_request", "That purchase request was already used.");
      }
      throw error;
    }

    const entitlementProducts = [product.id, ...delivery.grantedProductIds.filter((id) => id !== product.id)];
    for (const productId of entitlementProducts) {
      const isMain = productId === product.id;
      tx.insert(storeEntitlements)
        .values({
          userId: params.userId,
          productId,
          guildId: isMain ? delivery.guildId : null,
          quantity: isMain ? delivery.quantity : 1,
          days: isMain ? delivery.days : null,
          expiresAt: isMain ? delivery.expiresAt : null,
          ledgerId,
          createdAt: now,
        })
        .run();
    }

    return {
      ledgerId,
      product: { id: product.id, name: product.name },
      cost,
      currency,
      balance: balance - cost,
      guildId: delivery.guildId,
      days: delivery.days,
      expiresAt: delivery.expiresAt,
      grantedProductIds: delivery.grantedProductIds,
      replayed: false,
    } satisfies PurchaseReceipt;
  });
  if (!receipt.replayed && receipt.grantedProductIds.length > 0) invalidateUserCosmetics(params.userId);
  return receipt;
}

export type OwnedEntitlement = { productId: string; guildId: string | null; days: number | null; createdAt: Date };

/** What a member bought, newest first. */
export function listEntitlements(userId: string, limit = 200): OwnedEntitlement[] {
  return getDb()
    .select({
      productId: storeEntitlements.productId,
      guildId: storeEntitlements.guildId,
      days: storeEntitlements.days,
      createdAt: storeEntitlements.createdAt,
    })
    .from(storeEntitlements)
    .where(eq(storeEntitlements.userId, userId))
    .orderBy(desc(storeEntitlements.id))
    .limit(limit)
    .all();
}

/** Every product id this member has an entitlement for. */
export function ownedProductIds(userId: string): Set<string> {
  const rows = getDb()
    .selectDistinct({ productId: storeEntitlements.productId })
    .from(storeEntitlements)
    .where(eq(storeEntitlements.userId, userId))
    .all();
  return new Set(rows.map((row) => row.productId));
}

// --- Purchase request bodies --------------------------------------------------------------------

export type ParsedPurchaseBody =
  | { ok: true; productId: string; input: Record<string, unknown>; requestId: string | null; currency: Currency | null }
  | { ok: false; error: string };

/**
 * The website's purchase body: { productId, input: { guildId, days }, requestId, currency? }. The
 * older { guildId, days } body (from before the catalog) still works and buys Dreamliner One.
 */
export function parsePurchaseBody(body: unknown): ParsedPurchaseBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid JSON body" };
  const record = body as Record<string, unknown>;

  let requestId: string | null = null;
  if (record.requestId !== undefined && record.requestId !== null) {
    if (!isRequestId(record.requestId)) {
      return { ok: false, error: `requestId must be 1 to ${MAX_REQUEST_ID_LENGTH} characters.` };
    }
    requestId = record.requestId;
  }

  let currency: Currency | null = null;
  if (record.currency !== undefined && record.currency !== null) {
    if (!isCurrency(record.currency)) return { ok: false, error: "currency must be miles or credits." };
    currency = record.currency;
  }

  if (record.productId === undefined) {
    if (typeof record.guildId !== "string" || typeof record.days !== "number") {
      return { ok: false, error: "guildId and days are required." };
    }
    return { ok: true, productId: DREAMLINER_ONE_PRODUCT_ID, input: { guildId: record.guildId, days: record.days }, requestId, currency };
  }

  if (typeof record.productId !== "string" || !record.productId.trim()) {
    return { ok: false, error: "productId is required." };
  }
  const input = record.input;
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    return { ok: false, error: "input must be an object." };
  }
  return {
    ok: true,
    productId: record.productId.trim(),
    input: (input as Record<string, unknown> | undefined) ?? {},
    requestId,
    currency,
  };
}

// --- Admin -----------------------------------------------------------------------------------------

export class StoreProductInputError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;

type Fields = {
  type: ProductType;
  name: string;
  tagline: string;
  description: string;
  priceCredits: number;
  priceMiles: number | null;
  imageAssetId: string | null;
  heroAssetId: string | null;
  accentColor: number | null;
  badge: string | null;
  section: string;
  featured: boolean;
  sortOrder: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
  config: ProductConfig;
};

function text(input: Record<string, unknown>, field: string, max: number, required: boolean): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new StoreProductInputError(`${field} must be text.`, field);
  const trimmed = value.trim();
  if (required && !trimmed) throw new StoreProductInputError(`${field} is required.`, field);
  if (trimmed.length > max) throw new StoreProductInputError(`${field} must be ${max} characters or fewer.`, field);
  return trimmed;
}

function bool(input: Record<string, unknown>, field: string): boolean | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new StoreProductInputError(`${field} must be true or false.`, field);
  return value;
}

function int(input: Record<string, unknown>, field: string, min: number, max: number): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new StoreProductInputError(`${field} must be a whole number from ${min} to ${max}.`, field);
  }
  return value;
}

function assetId(input: Record<string, unknown>, field: string): string | null | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !ASSET_ID.test(value)) throw new StoreProductInputError(`${field} isn't a valid image.`, field);
  return value;
}

function date(input: Record<string, unknown>, field: string): Date | null | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) throw new StoreProductInputError(`${field} must be a date.`, field);
  return parsed;
}

function objectInput(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreProductInputError(`${field} must be an object.`, field);
  }
  return value as Record<string, unknown>;
}

/**
 * The type's config from admin input. Cosmetics take `slot` + `style` (top level, or inside
 * `config`); bundles take `bundleProductIds` (or `config.productIds`). Undefined when untouched.
 */
function config(id: string, type: ProductType, raw: Record<string, unknown>, base: ProductConfig, typeChanged: boolean): ProductConfig | undefined {
  const nested = raw.config === undefined ? undefined : objectInput(raw.config, "config");
  switch (type) {
    case "one_days": {
      if (!nested) return undefined;
      const current = base as OneDaysConfig;
      const dayStep = nested.dayStep === undefined ? current.dayStep : nested.dayStep;
      const maxDays = nested.maxDays === undefined ? current.maxDays : nested.maxDays;
      if (typeof dayStep !== "number" || !Number.isInteger(dayStep) || dayStep < 1 || dayStep > 30) {
        throw new StoreProductInputError("dayStep must be a whole number from 1 to 30.", "config.dayStep");
      }
      if (typeof maxDays !== "number" || !Number.isInteger(maxDays) || maxDays < dayStep || maxDays > 365) {
        throw new StoreProductInputError(`maxDays must be a whole number from ${dayStep} to 365.`, "config.maxDays");
      }
      return { dayStep, maxDays };
    }
    case "cosmetic": {
      const current = typeChanged ? null : (base as CosmeticConfig);
      const slotInput = raw.slot ?? nested?.slot;
      const styleInput = raw.style ?? nested?.style;
      if (slotInput === undefined && styleInput === undefined) {
        if (!current) throw new StoreProductInputError("A cosmetic needs a slot and a style.", "slot");
        return undefined;
      }
      const slot = slotInput === undefined ? current?.slot : slotInput;
      if (!isCosmeticSlot(slot)) throw new StoreProductInputError("slot isn't a cosmetic slot.", "slot");
      if (styleInput === undefined && (!current || current.slot !== slot)) {
        throw new StoreProductInputError("style is required when the slot changes.", "style");
      }
      const parsed = parseSlotStyle(slot, styleInput === undefined ? current!.style : styleInput);
      if (!parsed.ok) throw new StoreProductInputError(`style: ${parsed.error}`, parsed.path ? `style.${parsed.path}` : "style");
      return { slot, style: parsed.style };
    }
    case "bundle": {
      const idsInput = raw.bundleProductIds ?? nested?.productIds;
      if (idsInput === undefined) {
        if (typeChanged || (base as BundleConfig).productIds.length === 0) {
          throw new StoreProductInputError("A bundle needs bundleProductIds.", "bundleProductIds");
        }
        return undefined;
      }
      if (!Array.isArray(idsInput) || !idsInput.every((value) => typeof value === "string")) {
        throw new StoreProductInputError("bundleProductIds must be a list of product ids.", "bundleProductIds");
      }
      const ids = [...new Set(idsInput as string[])];
      if (ids.length < 2 || ids.length > MAX_BUNDLE_ITEMS) {
        throw new StoreProductInputError(`A bundle holds 2 to ${MAX_BUNDLE_ITEMS} cosmetics.`, "bundleProductIds");
      }
      if (ids.includes(id)) throw new StoreProductInputError("A bundle can't contain itself.", "bundleProductIds");
      const rows = getDb().select().from(storeProducts).where(inArray(storeProducts.id, ids)).all();
      const cosmetics = new Set(rows.map(fromRow).filter((item) => item?.type === "cosmetic").map((item) => item!.id));
      const bad = ids.find((value) => !cosmetics.has(value));
      if (bad) throw new StoreProductInputError(`${bad} isn't a cosmetic in the store.`, "bundleProductIds");
      return { productIds: ids };
    }
  }
}

function defaultConfig(type: ProductType): ProductConfig {
  switch (type) {
    case "one_days":
      return { ...DEFAULT_ONE_DAYS_CONFIG };
    case "cosmetic":
      // Placeholder only: config() refuses to save a cosmetic without a real slot and style.
      return { slot: "title", style: { text: "?", color: null } } as CosmeticConfig;
    case "bundle":
      return { productIds: [] };
  }
}

/** Validates admin input onto a base (the existing product, or defaults for a new one). */
function applyInput(id: string, base: Fields, raw: Record<string, unknown>, isNew: boolean): Fields {
  let type = base.type;
  if (raw.type !== undefined) {
    if (!isProductType(raw.type)) throw new StoreProductInputError(`type must be one of: ${PRODUCT_TYPES.join(", ")}.`, "type");
    type = raw.type;
  }
  const typeChanged = isNew || type !== base.type;
  const baseConfig = type === base.type ? base.config : defaultConfig(type);

  let badge: string | null | undefined;
  if (raw.badge === null) badge = null;
  else {
    const value = text(raw, "badge", 24, false);
    badge = value === undefined ? undefined : value || null;
  }

  let accentColor: number | null | undefined;
  if (raw.accentColor === null) accentColor = null;
  else accentColor = int(raw, "accentColor", 0, 0xffffff);

  const sellsInMiles = type !== "one_days";
  let priceCredits = base.priceCredits;
  let priceMiles = base.priceMiles;
  if (sellsInMiles) {
    // The credits price is derived from Miles; a priceCredits sent along is ignored.
    priceMiles = int(raw, "priceMiles", 0, 1_000_000) ?? (base.type === "one_days" ? null : base.priceMiles);
    if (priceMiles === null) throw new StoreProductInputError("priceMiles is required.", "priceMiles");
    priceCredits = 0;
  } else {
    priceCredits = int(raw, "priceCredits", 1, 1_000_000) ?? base.priceCredits;
    if (priceCredits < 1) throw new StoreProductInputError("priceCredits is required.", "priceCredits");
    priceMiles = null;
  }

  const next: Fields = {
    type,
    name: text(raw, "name", 80, true) ?? base.name,
    tagline: text(raw, "tagline", 160, false) ?? base.tagline,
    description: text(raw, "description", 4000, false) ?? base.description,
    priceCredits,
    priceMiles,
    imageAssetId: assetId(raw, "imageAssetId") === undefined ? base.imageAssetId : (assetId(raw, "imageAssetId") ?? null),
    heroAssetId: assetId(raw, "heroAssetId") === undefined ? base.heroAssetId : (assetId(raw, "heroAssetId") ?? null),
    accentColor: accentColor === undefined ? base.accentColor : accentColor,
    badge: badge === undefined ? base.badge : badge,
    section: text(raw, "section", 40, false) ?? base.section,
    featured: bool(raw, "featured") ?? base.featured,
    sortOrder: int(raw, "sortOrder", -100_000, 100_000) ?? base.sortOrder,
    startsAt: date(raw, "startsAt") === undefined ? base.startsAt : (date(raw, "startsAt") ?? null),
    endsAt: date(raw, "endsAt") === undefined ? base.endsAt : (date(raw, "endsAt") ?? null),
    active: bool(raw, "active") ?? base.active,
    config: config(id, type, raw, baseConfig, typeChanged) ?? baseConfig,
  };
  if (!next.name) throw new StoreProductInputError("name is required.", "name");
  if (!next.section) next.section = next.name;
  if (next.startsAt && next.endsAt && next.endsAt.getTime() <= next.startsAt.getTime()) {
    throw new StoreProductInputError("endsAt must be after startsAt.", "endsAt");
  }
  return next;
}

function toValues(fields: Fields) {
  return {
    type: fields.type,
    name: fields.name,
    tagline: fields.tagline,
    description: fields.description,
    priceCredits: fields.priceCredits,
    priceMiles: fields.priceMiles,
    imageAssetId: fields.imageAssetId,
    heroAssetId: fields.heroAssetId,
    accentColor: fields.accentColor,
    badge: fields.badge,
    section: fields.section,
    featured: fields.featured,
    sortOrder: fields.sortOrder,
    startsAt: fields.startsAt,
    endsAt: fields.endsAt,
    active: fields.active,
    configJson: JSON.stringify(fields.config),
  };
}

function readFresh(id: string): StoreProduct | null {
  const row = getDb().select().from(storeProducts).where(eq(storeProducts.id, id)).get();
  return row ? fromRow(row) : null;
}

/** Adds a product. id, type and name are required, plus priceCredits (one_days) or priceMiles
 *  (cosmetic, bundle), a slot and style (cosmetic) or bundleProductIds (bundle). */
export function createProduct(raw: Record<string, unknown>, actorId: string, now: Date = new Date()): StoreProduct {
  if (typeof raw.id !== "string" || !SLUG.test(raw.id)) {
    throw new StoreProductInputError("id must be 2 to 40 lowercase letters, numbers or dashes, starting with a letter or number.", "id");
  }
  if (raw.type === undefined) throw new StoreProductInputError("type is required.", "type");
  if (raw.name === undefined) throw new StoreProductInputError("name is required.", "name");
  if (!isProductType(raw.type)) throw new StoreProductInputError(`type must be one of: ${PRODUCT_TYPES.join(", ")}.`, "type");
  if (raw.type === "one_days" && raw.priceCredits === undefined) {
    throw new StoreProductInputError("priceCredits is required.", "priceCredits");
  }
  if (raw.type !== "one_days" && raw.priceMiles === undefined) {
    throw new StoreProductInputError("priceMiles is required.", "priceMiles");
  }
  const id = raw.id;
  if (getDb().select({ id: storeProducts.id }).from(storeProducts).where(eq(storeProducts.id, id)).get()) {
    throw new StoreProductInputError("A product with that id already exists.", "id");
  }
  const base: Fields = {
    type: raw.type,
    name: "",
    tagline: "",
    description: "",
    priceCredits: 1,
    priceMiles: raw.type === "one_days" ? null : 0,
    imageAssetId: null,
    heroAssetId: null,
    accentColor: null,
    badge: null,
    section: "",
    featured: false,
    sortOrder: 0,
    startsAt: null,
    endsAt: null,
    active: true,
    config: defaultConfig(raw.type),
  };
  const fields = applyInput(id, base, raw, true);
  getDb()
    .insert(storeProducts)
    .values({ id, ...toValues(fields), createdAt: now, updatedAt: now, updatedBy: actorId })
    .run();
  invalidateProductCache();
  return readFresh(id)!;
}

/** Changes a product (any subset of fields; the id can't change). Null when it doesn't exist. */
export function updateProduct(id: string, raw: Record<string, unknown>, actorId: string, now: Date = new Date()): StoreProduct | null {
  const existing = readFresh(id);
  if (!existing) return null;
  if (raw.id !== undefined && raw.id !== id) throw new StoreProductInputError("A product's id can't be changed.", "id");
  const fields = applyInput(id, existing, raw, false);
  getDb()
    .update(storeProducts)
    .set({ ...toValues(fields), updatedAt: now, updatedBy: actorId })
    .where(eq(storeProducts.id, id))
    .run();
  invalidateProductCache();
  return readFresh(id);
}

/** Takes a product off the store (purchases and entitlements stay). */
export function archiveProduct(id: string, actorId: string): StoreProduct | null {
  return updateProduct(id, { active: false }, actorId);
}

// --- Payloads for the website ------------------------------------------------------------------------

export type StoreBundleItemPayload = {
  id: string;
  name: string;
  slot: CosmeticSlot;
  priceMiles: number;
  style: CosmeticStyle;
};

export type StoreProductPayload = {
  id: string;
  type: ProductType;
  name: string;
  tagline: string;
  description: string;
  /** one_days: credits per day. cosmetic / bundle: the credits price (from priceMiles). */
  priceCredits: number;
  /** cosmetic / bundle: the Miles price. Null for one_days. */
  priceMiles: number | null;
  imageUrl: string | null;
  heroUrl: string | null;
  accentColor: number | null;
  badge: string | null;
  section: string;
  featured: boolean;
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  available: boolean;
  config: ProductConfig;
  /** cosmetic only. */
  slot: CosmeticSlot | null;
  /** cosmetic only: its single-slot style, e.g. { glow: {...} }. */
  style: CosmeticStyle | null;
  /** bundle only. */
  bundleItems: StoreBundleItemPayload[] | null;
  /** bundle only: what its items cost on their own, in Miles. */
  bundleValueMiles: number | null;
  createdAt: string;
};

export type StoreAdminProductPayload = StoreProductPayload & {
  active: boolean;
  imageAssetId: string | null;
  heroAssetId: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

/** Site-relative URL the website serves a store image at. */
export function storeAssetUrl(assetId: string | null): string | null {
  return assetId ? `/api/store/assets/${assetId}` : null;
}

/** A cosmetic's resolved style (e.g. { glow: {...} }), or null for other types. */
export function cosmeticStyleOf(product: StoreProduct): CosmeticStyle | null {
  const cosmetic = cosmeticConfigOf(product);
  return cosmetic ? resolveSlotStyle(cosmetic.slot, cosmetic.style) : null;
}

export function toProductPayload(product: StoreProduct, now: Date = new Date()): StoreProductPayload {
  const creditsPerMile = getStoreSettings().creditsPerMile;
  const cosmetic = cosmeticConfigOf(product);
  const bundle = bundleConfigOf(product);
  let bundleItems: StoreBundleItemPayload[] | null = null;
  if (bundle) {
    const byId = new Map(allProducts().map((item) => [item.id, item]));
    bundleItems = bundle.productIds.flatMap((id) => {
      const item = byId.get(id);
      const itemConfig = item ? cosmeticConfigOf(item) : null;
      if (!item || !itemConfig) return [];
      return [{ id: item.id, name: item.name, slot: itemConfig.slot, priceMiles: item.priceMiles ?? 0, style: cosmeticStyleOf(item)! }];
    });
  }
  return {
    id: product.id,
    type: product.type,
    name: product.name,
    tagline: product.tagline,
    description: product.description,
    priceCredits: unitPrice(product, "credits", creditsPerMile) ?? product.priceCredits,
    priceMiles: product.type === "one_days" ? null : (product.priceMiles ?? 0),
    imageUrl: storeAssetUrl(product.imageAssetId),
    heroUrl: storeAssetUrl(product.heroAssetId),
    accentColor: product.accentColor,
    badge: product.badge,
    section: product.section,
    featured: product.featured,
    sortOrder: product.sortOrder,
    startsAt: product.startsAt?.toISOString() ?? null,
    endsAt: product.endsAt?.toISOString() ?? null,
    available: isPurchasable(product, now),
    config: structuredClone(product.config),
    slot: cosmetic?.slot ?? null,
    style: cosmeticStyleOf(product),
    bundleItems,
    bundleValueMiles: bundleItems ? bundleItems.reduce((sum, item) => sum + item.priceMiles, 0) : null,
    createdAt: product.createdAt.toISOString(),
  };
}

export function toAdminProductPayload(product: StoreProduct, now: Date = new Date()): StoreAdminProductPayload {
  return {
    ...toProductPayload(product, now),
    active: product.active,
    imageAssetId: product.imageAssetId,
    heroAssetId: product.heroAssetId,
    updatedAt: product.updatedAt.toISOString(),
    updatedBy: product.updatedBy,
  };
}

/** The public catalog: listed products (active and not ended), the pricing, and the Miles packs. */
export function getStoreCatalog(now: Date = new Date()): {
  ok: true;
  products: StoreProductPayload[];
  pricing: { creditsPerVote: number; creditsPerMile: number };
  milesPacks: MilesPack[];
} {
  return {
    ok: true,
    products: listProducts()
      .filter((product) => isListed(product, now))
      .map((product) => toProductPayload(product, now)),
    pricing: { creditsPerVote: STORE_PRICING.creditsPerVote, creditsPerMile: getStoreSettings().creditsPerMile },
    milesPacks: getMilesPacks(),
  };
}
