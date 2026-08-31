import { eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeGlobalSettings } from "../../../db/schema.js";

const GLOBAL_ID = "global";

export type PackSettings = { packPrice: number; packSize: number };

function now() {
  return new Date();
}

/** Global (not per-guild) pack price/size, creating the single settings row on first access. */
export function getPackSettings(): PackSettings {
  const db = getDb();
  const existing = db.select().from(planeGlobalSettings).where(eq(planeGlobalSettings.id, GLOBAL_ID)).get();
  if (existing) return { packPrice: existing.packPrice, packSize: existing.packSize };

  db.insert(planeGlobalSettings)
    .values({ id: GLOBAL_ID, packPrice: 10, packSize: 1, updatedBy: "", updatedAt: now() })
    .onConflictDoNothing()
    .run();
  const row = db.select().from(planeGlobalSettings).where(eq(planeGlobalSettings.id, GLOBAL_ID)).get()!;
  return { packPrice: row.packPrice, packSize: row.packSize };
}

export function setPackSettings(patch: Partial<PackSettings>, updatedBy: string): PackSettings {
  getPackSettings(); // ensure the row exists before updating
  const db = getDb();
  db.update(planeGlobalSettings)
    .set({ ...patch, updatedBy, updatedAt: now() })
    .where(eq(planeGlobalSettings.id, GLOBAL_ID))
    .run();
  return getPackSettings();
}
