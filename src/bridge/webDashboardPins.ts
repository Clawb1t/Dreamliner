/**
 * Dashboard sidebar favourites ("Pinned"): the pages one user pinned to the top of one server's
 * dashboard sidebar. User-scoped like Ghost Mode: the website puts the signed-in user's id (from
 * its Auth.js session) in the path, after checking the user can open that server's dashboard.
 *
 *   GET /bridge/users/:userId/dashboard-pins/:guildId   -> { pins: string[] }
 *   PUT /bridge/users/:userId/dashboard-pins/:guildId   { pins: string[] } -> { pins: string[] }
 *
 * Pins are only a display preference of the user's own (no server data, nothing anyone else sees),
 * so the only checks are on the shape: known-looking section ids, no repeats, at most MAX_PINS.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { dashboardPins } from "../db/schema.js";

export const MAX_DASHBOARD_PINS = 8;

/** A dashboard section id: "server", "logs", "plugin:automod", "plugin:automod/spam" and so on. */
const PIN_ID = /^[a-z0-9_]{1,48}(?::[a-z0-9_]{1,48}(?:\/[a-z0-9_]{1,48})?)?$/;

/** Cleans a pin list from the website: valid ids only, first copy of each, capped. Null if not a list. */
export function normalizeDashboardPins(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !PIN_ID.test(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length >= MAX_DASHBOARD_PINS) break;
  }
  return out;
}

export function getDashboardPins(userId: string, guildId: string): string[] {
  const row = getDb()
    .select({ pins: dashboardPins.pins })
    .from(dashboardPins)
    .where(and(eq(dashboardPins.userId, userId), eq(dashboardPins.guildId, guildId)))
    .get();
  if (!row) return [];
  try {
    return normalizeDashboardPins(JSON.parse(row.pins)) ?? [];
  } catch {
    return [];
  }
}

export function setDashboardPins(userId: string, guildId: string, raw: unknown): { ok: true; pins: string[] } | { ok: false; status: number; error: string } {
  const pins = normalizeDashboardPins(raw);
  if (!pins) return { ok: false, status: 400, error: "pins must be a list of page ids." };
  const db = getDb();
  if (pins.length === 0) {
    db.delete(dashboardPins).where(and(eq(dashboardPins.userId, userId), eq(dashboardPins.guildId, guildId))).run();
    return { ok: true, pins };
  }
  const now = new Date();
  db.insert(dashboardPins)
    .values({ userId, guildId, pins: JSON.stringify(pins), updatedAt: now })
    .onConflictDoUpdate({ target: [dashboardPins.userId, dashboardPins.guildId], set: { pins: JSON.stringify(pins), updatedAt: now } })
    .run();
  return { ok: true, pins };
}
