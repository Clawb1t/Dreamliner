import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { animeSavedNekos } from "../../../db/schema.js";

/** Product limit — keeps a member's saved list a manageable size to page through. */
export const SAVED_NEKO_CAP = 100;

export type SavedNeko = {
  id: number;
  userId: string;
  imageUrl: string;
  artistName: string | null;
  artistHref: string | null;
  createdAt: Date;
};

function rowToSaved(row: typeof animeSavedNekos.$inferSelect): SavedNeko {
  return {
    id: row.id,
    userId: row.userId,
    imageUrl: row.imageUrl,
    artistName: row.artistName,
    artistHref: row.artistHref,
    createdAt: row.createdAt,
  };
}

export async function listSavedNekos(userId: string): Promise<SavedNeko[]> {
  const rows = await getDb()
    .select()
    .from(animeSavedNekos)
    .where(eq(animeSavedNekos.userId, userId))
    .orderBy(desc(animeSavedNekos.createdAt));
  return rows.map(rowToSaved);
}

export async function saveNeko(
  userId: string,
  neko: { imageUrl: string; artistName: string | null; artistHref: string | null },
): Promise<{ ok: true; saved: SavedNeko } | { ok: false; error: string }> {
  const db = getDb();

  const existing = await db
    .select()
    .from(animeSavedNekos)
    .where(and(eq(animeSavedNekos.userId, userId), eq(animeSavedNekos.imageUrl, neko.imageUrl)))
    .get();
  if (existing) {
    return { ok: false, error: "You've already saved this one." };
  }

  const total = await db
    .select({ n: count() })
    .from(animeSavedNekos)
    .where(eq(animeSavedNekos.userId, userId))
    .get();
  if ((total?.n ?? 0) >= SAVED_NEKO_CAP) {
    return { ok: false, error: `You've saved the max of ${SAVED_NEKO_CAP} nekos — unsave one first.` };
  }

  const inserted = await db
    .insert(animeSavedNekos)
    .values({
      userId,
      imageUrl: neko.imageUrl,
      artistName: neko.artistName,
      artistHref: neko.artistHref,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return { ok: true, saved: rowToSaved(inserted) };
}

export async function unsaveNeko(userId: string, id: number): Promise<boolean> {
  const deleted = await getDb()
    .delete(animeSavedNekos)
    .where(and(eq(animeSavedNekos.userId, userId), eq(animeSavedNekos.id, id)))
    .returning()
    .get();
  return Boolean(deleted);
}
