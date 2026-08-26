import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { badgeDefinitions, userBadges } from "../db/schema.js";

export type Badge = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  icon: string;
  iconImageUrl: string | null;
  colorHex: string | null;
  createdAt: string;
  updatedAt: string;
};

const KEY_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/** Rough cap on the decoded image size (bytes) so badge icons stay small. */
const MAX_ICON_IMAGE_BYTES = 300 * 1024;

function toBadge(row: typeof badgeDefinitions.$inferSelect): Badge {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    icon: row.icon,
    iconImageUrl: row.iconImage ? `data:image/png;base64,${row.iconImage}` : null,
    colorHex: row.colorHex ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function normalizeBadgeKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return KEY_RE.test(trimmed) ? trimmed : null;
}

export function normalizeBadgeColor(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!HEX_RE.test(withHash)) return undefined;
  return withHash.toLowerCase();
}

/**
 * Normalizes a raw badge icon image upload (base64 PNG, optionally with a
 * `data:image/...;base64,` prefix that the browser's FileReader adds).
 * Returns `undefined` for "field not provided", `null` to clear the image,
 * or the bare base64 string on success — throws on an invalid/oversized image.
 */
export function normalizeBadgeIconImage(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error("iconImage must be a base64 image string or null.");
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const base64 = trimmed.startsWith("data:") ? trimmed.split(",", 2)[1] ?? "" : trimmed;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length === 0) {
    throw new Error("iconImage is not valid base64 image data.");
  }
  const approxBytes = (base64.length * 3) / 4;
  if (approxBytes > MAX_ICON_IMAGE_BYTES) {
    throw new Error("Badge icon image is too large (max 300KB).");
  }
  return base64;
}

export async function listBadges(): Promise<Badge[]> {
  const rows = await getDb().select().from(badgeDefinitions).orderBy(badgeDefinitions.name).all();
  return rows.map(toBadge);
}

export async function getBadgeById(id: number): Promise<Badge | null> {
  const row = await getDb().select().from(badgeDefinitions).where(eq(badgeDefinitions.id, id)).get();
  return row ? toBadge(row) : null;
}

export type CreateBadgeInput = {
  key: string;
  name: string;
  description: string | null;
  icon: string;
  iconImage: string | null;
  colorHex: string | null;
};

export async function createBadge(input: CreateBadgeInput): Promise<Badge> {
  const existing = await getDb()
    .select()
    .from(badgeDefinitions)
    .where(eq(badgeDefinitions.key, input.key))
    .get();
  if (existing) {
    throw new Error(`A badge with key "${input.key}" already exists.`);
  }
  const now = new Date();
  await getDb()
    .insert(badgeDefinitions)
    .values({
      key: input.key,
      name: input.name,
      description: input.description,
      icon: input.icon,
      iconImage: input.iconImage,
      colorHex: input.colorHex,
      createdAt: now,
      updatedAt: now,
    });
  const row = await getDb().select().from(badgeDefinitions).where(eq(badgeDefinitions.key, input.key)).get();
  if (!row) throw new Error("Failed to save badge.");
  return toBadge(row);
}

export type UpdateBadgeInput = Partial<Omit<CreateBadgeInput, "key">>;

export async function updateBadge(id: number, input: UpdateBadgeInput): Promise<Badge | null> {
  const existing = await getDb().select().from(badgeDefinitions).where(eq(badgeDefinitions.id, id)).get();
  if (!existing) return null;

  const patch: Partial<typeof badgeDefinitions.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.iconImage !== undefined) patch.iconImage = input.iconImage;
  if (input.colorHex !== undefined) patch.colorHex = input.colorHex;

  await getDb().update(badgeDefinitions).set(patch).where(eq(badgeDefinitions.id, id));
  return getBadgeById(id);
}

export async function deleteBadge(id: number): Promise<boolean> {
  const existing = await getDb().select().from(badgeDefinitions).where(eq(badgeDefinitions.id, id)).get();
  if (!existing) return false;
  await getDb().delete(userBadges).where(eq(userBadges.badgeId, id));
  await getDb().delete(badgeDefinitions).where(eq(badgeDefinitions.id, id));
  return true;
}
