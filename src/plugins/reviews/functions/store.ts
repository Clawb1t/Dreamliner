import { and, count, desc, eq, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { reviews } from "../../../db/schema.js";

export type Review = {
  id: number;
  guildId: string;
  userId: string;
  rating: number;
  content: string;
  anonymous: boolean;
  channelId: string | null;
  messageId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

function mapRow(row: typeof reviews.$inferSelect): Review {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    rating: row.rating,
    content: row.content,
    anonymous: row.anonymous,
    channelId: row.channelId,
    messageId: row.messageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export async function getActiveReviewByUser(guildId: string, userId: string): Promise<Review | null> {
  const row = await getDb()
    .select()
    .from(reviews)
    .where(and(eq(reviews.guildId, guildId), eq(reviews.userId, userId), isNull(reviews.deletedAt)))
    .orderBy(desc(reviews.id))
    .limit(1)
    .get();
  return row ? mapRow(row) : null;
}

export async function getReviewById(guildId: string, id: number): Promise<Review | null> {
  const row = await getDb()
    .select()
    .from(reviews)
    .where(and(eq(reviews.guildId, guildId), eq(reviews.id, id)))
    .get();
  return row ? mapRow(row) : null;
}

export async function createReview(input: {
  guildId: string;
  userId: string;
  rating: number;
  content: string;
  anonymous: boolean;
}): Promise<Review> {
  const now = new Date();
  const inserted = await getDb()
    .insert(reviews)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      rating: input.rating,
      content: input.content,
      anonymous: input.anonymous,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapRow(inserted[0]!);
}

export async function updateReview(
  id: number,
  patch: Partial<{
    rating: number;
    content: string;
    anonymous: boolean;
    channelId: string | null;
    messageId: string | null;
    deletedAt: Date | null;
  }>,
): Promise<Review | null> {
  const updated = await getDb()
    .update(reviews)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(reviews.id, id))
    .returning();
  return updated[0] ? mapRow(updated[0]) : null;
}

export async function softDeleteReview(guildId: string, id: number): Promise<Review | null> {
  const existing = await getReviewById(guildId, id);
  if (!existing || existing.deletedAt) return null;
  return updateReview(id, { deletedAt: new Date() });
}

export type ListReviewsQuery = {
  q?: string;
  rating?: number | null;
  userId?: string | null;
  includeDeleted?: boolean;
  limit: number;
  offset: number;
};

export async function listReviews(guildId: string, query: ListReviewsQuery) {
  const filters: SQL[] = [eq(reviews.guildId, guildId)];
  if (!query.includeDeleted) filters.push(isNull(reviews.deletedAt));
  if (query.rating != null) filters.push(eq(reviews.rating, query.rating));
  if (query.userId) filters.push(eq(reviews.userId, query.userId));
  if (query.q) {
    const q = query.q;
    if (/^\d{17,20}$/.test(q)) {
      filters.push(eq(reviews.userId, q));
    } else if (/^\d+$/.test(q)) {
      filters.push(or(eq(reviews.id, Number(q)), like(reviews.content, `%${q}%`))!);
    } else {
      filters.push(like(reviews.content, `%${q}%`));
    }
  }

  const where = and(...filters)!;
  const db = getDb();
  const [totalRow] = await db.select({ value: count() }).from(reviews).where(where);
  const rows = await db
    .select()
    .from(reviews)
    .where(where)
    .orderBy(desc(reviews.id))
    .limit(query.limit)
    .offset(query.offset);

  return {
    reviews: rows.map(mapRow),
    total: Number(totalRow?.value ?? 0),
  };
}

export async function averageRating(guildId: string): Promise<{ average: number; count: number }> {
  const row = await getDb()
    .select({
      average: sql<number>`avg(${reviews.rating})`,
      count: count(),
    })
    .from(reviews)
    .where(and(eq(reviews.guildId, guildId), isNull(reviews.deletedAt)))
    .get();
  return {
    average: Number(row?.average ?? 0),
    count: Number(row?.count ?? 0),
  };
}
