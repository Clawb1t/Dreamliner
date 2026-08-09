import { and, count, desc, eq, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { Guild } from "discord.js";
import { getDb } from "../db/client.js";
import { reviews } from "../db/schema.js";
import { softDeleteReview } from "../plugins/reviews/functions/store.js";

export type WebPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

export type WebReview = {
  id: number;
  rating: number;
  content: string;
  anonymous: boolean;
  channelId: string | null;
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  user: WebPerson;
};

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type WebReviewsQuery = {
  q: string;
  rating: number | null;
  userId: string | null;
  includeDeleted: boolean;
  limit: number;
  offset: number;
};

export function parseWebReviewsQuery(url: URL): WebReviewsQuery {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const ratingRaw = url.searchParams.get("rating");
  const rating = ratingRaw ? Number(ratingRaw) : null;
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    rating: rating != null && rating >= 1 && rating <= 5 ? rating : null,
    userId: url.searchParams.get("user")?.trim() || null,
    includeDeleted: url.searchParams.get("deleted") === "true",
    limit,
    offset,
  };
}

async function resolvePerson(guild: Guild, userId: string): Promise<WebPerson> {
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  return {
    id: userId,
    name: member?.displayName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function listWebReviews(guild: Guild, query: WebReviewsQuery) {
  const filters: SQL[] = [eq(reviews.guildId, guild.id)];
  if (!query.includeDeleted) filters.push(isNull(reviews.deletedAt));
  if (query.rating != null) filters.push(eq(reviews.rating, query.rating));
  if (query.userId) filters.push(eq(reviews.userId, query.userId));
  if (query.q) {
    const q = query.q;
    if (/^\d{17,20}$/.test(q)) filters.push(eq(reviews.userId, q));
    else if (/^\d+$/.test(q)) filters.push(or(eq(reviews.id, Number(q)), like(reviews.content, `%${q}%`))!);
    else filters.push(like(reviews.content, `%${q}%`));
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

  const people = await Promise.all(rows.map((row) => resolvePerson(guild, row.userId)));
  const byId = new Map(people.map((p) => [p.id, p]));

  const avgRow = await db
    .select({ average: sql<number>`avg(${reviews.rating})`, count: count() })
    .from(reviews)
    .where(and(eq(reviews.guildId, guild.id), isNull(reviews.deletedAt)))
    .get();

  return {
    reviews: rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      content: row.content,
      anonymous: row.anonymous,
      channelId: row.channelId,
      messageId: row.messageId,
      createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
      updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
      deletedAt: toIso(row.deletedAt),
      user: byId.get(row.userId) ?? {
        id: row.userId,
        name: row.userId,
        username: null,
        avatar: null,
      },
    })),
    total: Number(totalRow?.value ?? 0),
    limit: query.limit,
    offset: query.offset,
    average: Number(avgRow?.average ?? 0),
    ratedCount: Number(avgRow?.count ?? 0),
  };
}

export async function getWebReview(guild: Guild, reviewId: number): Promise<WebReview | null> {
  const row = await getDb()
    .select()
    .from(reviews)
    .where(and(eq(reviews.guildId, guild.id), eq(reviews.id, reviewId)))
    .get();
  if (!row) return null;
  const user = await resolvePerson(guild, row.userId);
  return {
    id: row.id,
    rating: row.rating,
    content: row.content,
    anonymous: row.anonymous,
    channelId: row.channelId,
    messageId: row.messageId,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
    deletedAt: toIso(row.deletedAt),
    user,
  };
}

export async function deleteWebReview(guild: Guild, reviewId: number) {
  return softDeleteReview(guild.id, reviewId);
}
