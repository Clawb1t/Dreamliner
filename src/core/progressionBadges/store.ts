import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { loadImage } from "@napi-rs/canvas";
import { getDb } from "../../db/client.js";
import { progressionBadges, progressionBadgeTiers, userProgressionBadgeGrants } from "../../db/schema.js";
import { getMetric, MANUAL_METRIC_ID } from "./metrics.js";

/** Progression badges made on the superuser dashboard, their tier art, and hand assignments. */

export const MAX_TIERS = 10;
export const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_IMAGE_SIDE = 2048;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const KEY_PATTERN = /^[a-z0-9_]{2,32}$/;

export type StoredTier = {
  id: number;
  position: number;
  threshold: number;
  name: string;
  imageVersion: string;
};

export type StoredBadge = {
  id: number;
  key: string;
  name: string;
  description: string;
  metric: string;
  enabled: boolean;
  displayOrder: number;
  tiers: StoredTier[];
};

export class BadgeInputError extends Error {}

// --- Reads (cached, since leaderboards resolve badges on every render) -------------------------

const CACHE_TTL_MS = 30_000;
let cache: { at: number; badges: StoredBadge[] } | null = null;

export function invalidateBadgeCache(): void {
  cache = null;
}

export async function listStoredBadges(): Promise<StoredBadge[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.badges;
  const db = getDb();
  const badges = db.select().from(progressionBadges).orderBy(asc(progressionBadges.displayOrder), asc(progressionBadges.id)).all();
  const tiers = db
    .select({
      id: progressionBadgeTiers.id,
      badgeId: progressionBadgeTiers.badgeId,
      position: progressionBadgeTiers.position,
      threshold: progressionBadgeTiers.threshold,
      name: progressionBadgeTiers.name,
      imageVersion: progressionBadgeTiers.imageVersion,
    })
    .from(progressionBadgeTiers)
    .orderBy(asc(progressionBadgeTiers.position))
    .all();
  const result = badges.map((badge) => ({
    id: badge.id,
    key: badge.key,
    name: badge.name,
    description: badge.description,
    metric: badge.metric,
    enabled: badge.enabled,
    displayOrder: badge.displayOrder,
    tiers: tiers
      .filter((tier) => tier.badgeId === badge.id)
      .map(({ id, position, threshold, name, imageVersion }) => ({ id, position, threshold, name, imageVersion })),
  }));
  cache = { at: Date.now(), badges: result };
  return result;
}

const imageCache = new Map<number, { version: string; buffer: Buffer; contentType: string }>();

export async function getTierImage(tierId: number): Promise<{ buffer: Buffer; contentType: string } | null> {
  const row = getDb()
    .select({ version: progressionBadgeTiers.imageVersion })
    .from(progressionBadgeTiers)
    .where(eq(progressionBadgeTiers.id, tierId))
    .get();
  if (!row) return null;
  const cached = imageCache.get(tierId);
  if (cached && cached.version === row.version) return cached;
  const full = getDb()
    .select({ image: progressionBadgeTiers.image, contentType: progressionBadgeTiers.contentType })
    .from(progressionBadgeTiers)
    .where(eq(progressionBadgeTiers.id, tierId))
    .get();
  if (!full) return null;
  const entry = { version: row.version, buffer: Buffer.from(full.image), contentType: full.contentType };
  imageCache.set(tierId, entry);
  return entry;
}

// --- Writes ----------------------------------------------------------------------------------

export type TierInput = {
  threshold?: unknown;
  name?: unknown;
  /** New art as a data URL. */
  image?: unknown;
  /** Keep the art of this existing tier (when editing). */
  keepImageFrom?: unknown;
};

export type BadgeInput = {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  metric?: unknown;
  enabled?: unknown;
  tiers?: unknown;
};

type PreparedTier = {
  threshold: number;
  name: string;
  image: Buffer;
  contentType: string;
  imageVersion: string;
};

function text(value: unknown, max: number, field: string, required = false): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new BadgeInputError(`${field} is required.`);
  if (result.length > max) throw new BadgeInputError(`${field} must be ${max} characters or fewer.`);
  return result;
}

/** Validates an uploaded data URL and makes sure it really decodes as an image. */
export async function parseImageDataUrl(value: string): Promise<{ buffer: Buffer; contentType: string }> {
  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  const contentType = match?.[1] as (typeof IMAGE_TYPES)[number] | undefined;
  if (!match || !contentType || !IMAGE_TYPES.includes(contentType)) {
    throw new BadgeInputError("Tier images must be PNG, JPEG, WebP or GIF.");
  }
  const buffer = Buffer.from(match[2]!, "base64");
  if (buffer.length === 0) throw new BadgeInputError("That image is empty.");
  if (buffer.length > MAX_IMAGE_BYTES) throw new BadgeInputError("Tier images must be 256 KB or smaller.");
  let decoded;
  try {
    decoded = await loadImage(buffer);
  } catch {
    throw new BadgeInputError("That file isn't a readable image.");
  }
  if (decoded.width > MAX_IMAGE_SIDE || decoded.height > MAX_IMAGE_SIDE) {
    throw new BadgeInputError(`Tier images must be at most ${MAX_IMAGE_SIDE}×${MAX_IMAGE_SIDE}.`);
  }
  return { buffer, contentType };
}

function newVersion(): string {
  return randomBytes(6).toString("hex");
}

async function prepareTiers(raw: unknown, metric: string, existingBadgeId: number | null): Promise<PreparedTier[]> {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadgeInputError("Add at least one tier.");
  if (raw.length > MAX_TIERS) throw new BadgeInputError(`A badge can have at most ${MAX_TIERS} tiers.`);
  const manual = metric === MANUAL_METRIC_ID;
  const prepared: PreparedTier[] = [];
  for (const [index, entry] of (raw as TierInput[]).entries()) {
    const label = `Tier ${index + 1}`;
    let threshold = 0;
    if (!manual) {
      threshold = Number(entry?.threshold);
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 1_000_000_000) {
        throw new BadgeInputError(`${label} needs a whole-number goal of at least 1.`);
      }
    }
    const name = text(entry?.name, 40, `${label} name`);
    let image: { buffer: Buffer; contentType: string; imageVersion: string } | null = null;
    if (typeof entry?.image === "string" && entry.image) {
      image = { ...(await parseImageDataUrl(entry.image)), imageVersion: newVersion() };
    } else if (existingBadgeId != null && entry?.keepImageFrom != null) {
      const row = getDb()
        .select()
        .from(progressionBadgeTiers)
        .where(
          and(eq(progressionBadgeTiers.id, Number(entry.keepImageFrom)), eq(progressionBadgeTiers.badgeId, existingBadgeId)),
        )
        .get();
      if (row) image = { buffer: Buffer.from(row.image), contentType: row.contentType, imageVersion: row.imageVersion };
    }
    if (!image) throw new BadgeInputError(`${label} needs an image.`);
    prepared.push({ threshold, name, image: image.buffer, contentType: image.contentType, imageVersion: image.imageVersion });
  }
  if (!manual) {
    prepared.sort((a, b) => a.threshold - b.threshold);
    for (let i = 1; i < prepared.length; i++) {
      if (prepared[i]!.threshold === prepared[i - 1]!.threshold) {
        throw new BadgeInputError("Each tier needs a different goal.");
      }
    }
  }
  return prepared;
}

function writeTiers(badgeId: number, tiers: PreparedTier[]): void {
  const db = getDb();
  db.delete(progressionBadgeTiers).where(eq(progressionBadgeTiers.badgeId, badgeId)).run();
  tiers.forEach((tier, index) => {
    db.insert(progressionBadgeTiers)
      .values({
        badgeId,
        position: index + 1,
        threshold: tier.threshold,
        name: tier.name,
        image: tier.image,
        contentType: tier.contentType,
        imageVersion: tier.imageVersion,
      })
      .run();
  });
}

export function normalizeBadgeKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!KEY_PATTERN.test(key)) {
    throw new BadgeInputError("Key must be 2 to 32 lowercase letters, numbers or underscores.");
  }
  return key;
}

function parseCommon(input: BadgeInput) {
  const metric = typeof input.metric === "string" ? input.metric : "";
  if (!getMetric(metric)) throw new BadgeInputError("Pick a stat for this badge to track.");
  return {
    name: text(input.name, 40, "Name", true),
    description: text(input.description, 160, "Description"),
    metric,
    enabled: input.enabled !== false,
  };
}

export async function createStoredBadge(input: BadgeInput, actorId: string, reservedKeys: string[]): Promise<number> {
  const key = normalizeBadgeKey(input.key);
  if (reservedKeys.includes(key)) throw new BadgeInputError("That key belongs to a built-in badge.");
  const db = getDb();
  if (db.select({ id: progressionBadges.id }).from(progressionBadges).where(eq(progressionBadges.key, key)).get()) {
    throw new BadgeInputError("A progression badge with that key already exists.");
  }
  const common = parseCommon(input);
  const tiers = await prepareTiers(input.tiers, common.metric, null);
  const last = db
    .select({ order: progressionBadges.displayOrder })
    .from(progressionBadges)
    .orderBy(asc(progressionBadges.displayOrder))
    .all()
    .at(-1);
  const now = new Date();
  const id = db.transaction(() => {
    const row = db
      .insert(progressionBadges)
      .values({ key, ...common, displayOrder: (last?.order ?? 0) + 1, createdBy: actorId, createdAt: now, updatedAt: now })
      .returning({ id: progressionBadges.id })
      .get();
    writeTiers(row.id, tiers);
    return row.id;
  });
  invalidateBadgeCache();
  return id;
}

export async function updateStoredBadge(id: number, input: BadgeInput): Promise<boolean> {
  const db = getDb();
  const existing = db.select().from(progressionBadges).where(eq(progressionBadges.id, id)).get();
  if (!existing) return false;
  const common = parseCommon(input);
  const tiers = await prepareTiers(input.tiers, common.metric, id);
  db.transaction(() => {
    db.update(progressionBadges).set({ ...common, updatedAt: new Date() }).where(eq(progressionBadges.id, id)).run();
    writeTiers(id, tiers);
  });
  invalidateBadgeCache();
  return true;
}

export function setStoredBadgeEnabled(id: number, enabled: boolean): boolean {
  const result = getDb()
    .update(progressionBadges)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(progressionBadges.id, id))
    .run();
  invalidateBadgeCache();
  return result.changes > 0;
}

export function deleteStoredBadge(id: number): boolean {
  const db = getDb();
  const existing = db.select({ key: progressionBadges.key }).from(progressionBadges).where(eq(progressionBadges.id, id)).get();
  if (!existing) return false;
  db.transaction(() => {
    db.delete(progressionBadgeTiers).where(eq(progressionBadgeTiers.badgeId, id)).run();
    db.delete(userProgressionBadgeGrants).where(eq(userProgressionBadgeGrants.badgeKey, existing.key)).run();
    db.delete(progressionBadges).where(eq(progressionBadges.id, id)).run();
  });
  invalidateBadgeCache();
  return true;
}

/** Saves the display order: `ids` left to right. Unknown ids are ignored. */
export function reorderStoredBadges(ids: number[]): void {
  const db = getDb();
  db.transaction(() => {
    ids.forEach((id, index) => {
      db.update(progressionBadges).set({ displayOrder: index + 1 }).where(eq(progressionBadges.id, id)).run();
    });
  });
  invalidateBadgeCache();
}

// --- Hand assignments --------------------------------------------------------------------------

export type BadgeGrant = { badgeKey: string; tier: number | null; grantedBy: string; grantedAt: Date };

export async function listGrantsForUsers(userIds: string[]): Promise<Map<string, Map<string, BadgeGrant>>> {
  const result = new Map<string, Map<string, BadgeGrant>>();
  if (userIds.length === 0) return result;
  const rows = getDb()
    .select()
    .from(userProgressionBadgeGrants)
    .where(inArray(userProgressionBadgeGrants.userId, userIds))
    .all();
  for (const row of rows) {
    const byKey = result.get(row.userId) ?? new Map<string, BadgeGrant>();
    byKey.set(row.badgeKey, { badgeKey: row.badgeKey, tier: row.tier, grantedBy: row.grantedBy, grantedAt: row.grantedAt });
    result.set(row.userId, byKey);
  }
  return result;
}

export function grantBadge(userId: string, badgeKey: string, tier: number | null, actorId: string): void {
  const grantedAt = new Date();
  getDb()
    .insert(userProgressionBadgeGrants)
    .values({ userId, badgeKey, tier, grantedBy: actorId, grantedAt })
    .onConflictDoUpdate({
      target: [userProgressionBadgeGrants.userId, userProgressionBadgeGrants.badgeKey],
      set: { tier, grantedBy: actorId, grantedAt },
    })
    .run();
}

export function revokeBadge(userId: string, badgeKey: string): boolean {
  return (
    getDb()
      .delete(userProgressionBadgeGrants)
      .where(and(eq(userProgressionBadgeGrants.userId, userId), eq(userProgressionBadgeGrants.badgeKey, badgeKey)))
      .run().changes > 0
  );
}

/** How many users have each badge assigned by hand. */
export function countGrantsByBadge(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of getDb().select({ key: userProgressionBadgeGrants.badgeKey }).from(userProgressionBadgeGrants).all()) {
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  }
  return counts;
}
