import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { storeSettings } from "../../db/schema.js";

/** Store-wide settings, edited by platform superusers on the store admin page. */

export const DEFAULT_CREDITS_PER_MILE = 2;
export const MIN_CREDITS_PER_MILE = 0.01;
export const MAX_CREDITS_PER_MILE = 1000;

export type StoreSettings = { creditsPerMile: number };

let cache: { at: number; settings: StoreSettings } | null = null;
const CACHE_MS = 30_000;

export function getStoreSettings(): StoreSettings {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.settings;
  const row = getDb().select().from(storeSettings).where(eq(storeSettings.id, 1)).get();
  const rate = row?.creditsPerMile;
  const settings = {
    creditsPerMile: typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_CREDITS_PER_MILE,
  };
  cache = { at: Date.now(), settings };
  return settings;
}

export class StoreSettingsInputError extends Error {}

export function updateStoreSettings(input: Record<string, unknown>, actorId: string, now: Date = new Date()): StoreSettings {
  const rate = input.creditsPerMile;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < MIN_CREDITS_PER_MILE || rate > MAX_CREDITS_PER_MILE) {
    throw new StoreSettingsInputError(`creditsPerMile must be a number from ${MIN_CREDITS_PER_MILE} to ${MAX_CREDITS_PER_MILE}.`);
  }
  const creditsPerMile = Math.round(rate * 100) / 100;
  getDb()
    .insert(storeSettings)
    .values({ id: 1, creditsPerMile, updatedAt: now, updatedBy: actorId })
    .onConflictDoUpdate({ target: storeSettings.id, set: { creditsPerMile, updatedAt: now, updatedBy: actorId } })
    .run();
  cache = null;
  return getStoreSettings();
}

/** The credits price of something priced in Miles. */
export function creditsForMiles(miles: number, creditsPerMile: number = getStoreSettings().creditsPerMile): number {
  // Rounded first so float noise (e.g. 300 x 1.1) can't add a whole credit.
  return Math.ceil(Math.round(miles * creditsPerMile * 1e6) / 1e6);
}

export function getMilesEntitlementCursor(): string | null {
  return getDb().select({ cursor: storeSettings.milesEntitlementCursor }).from(storeSettings).where(eq(storeSettings.id, 1)).get()?.cursor ?? null;
}

export function setMilesEntitlementCursor(cursor: string): void {
  getDb()
    .insert(storeSettings)
    .values({ id: 1, creditsPerMile: DEFAULT_CREDITS_PER_MILE, milesEntitlementCursor: cursor })
    .onConflictDoUpdate({ target: storeSettings.id, set: { milesEntitlementCursor: cursor } })
    .run();
}
