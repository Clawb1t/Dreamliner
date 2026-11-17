import { eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardUserState } from "../../../db/schema.js";
import { HANGAR_BASE_SLOTS } from "./constants.js";

export type UserStateRow = typeof planeCardUserState.$inferSelect;

export function getUserState(userId: string): UserStateRow | null {
  return getDb().select().from(planeCardUserState).where(eq(planeCardUserState.userId, userId)).get() ?? null;
}

export function ensureUserState(userId: string): UserStateRow {
  const existing = getUserState(userId);
  if (existing) return existing;
  getDb()
    .insert(planeCardUserState)
    .values({ userId, hangarSlots: HANGAR_BASE_SLOTS, updatedAt: new Date() })
    .onConflictDoNothing()
    .run();
  return getUserState(userId)!;
}

export function updateUserState(userId: string, patch: Partial<Omit<UserStateRow, "userId">>): void {
  ensureUserState(userId);
  getDb()
    .update(planeCardUserState)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(planeCardUserState.userId, userId))
    .run();
}

export function parsePity(raw: string | null | undefined): Record<string, number> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "number" && value >= 0) out[key] = Math.floor(value);
    return out;
  } catch {
    return {};
  }
}

export function parseShowcase(raw: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}
