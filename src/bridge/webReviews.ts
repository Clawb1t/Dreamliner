import { and, asc, count, desc, eq, gte, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import type { Guild } from "discord.js";
import { getDb } from "../db/client.js";
import { reviews } from "../db/schema.js";
import { configManager } from "../config/manager.js";
import { zReviewsConfig } from "../config/schemas/reviews.js";
import { getReviewById, softDeleteReview, updateReview, type Review } from "../plugins/reviews/functions/store.js";
import { deleteReviewPost, syncReviewPost } from "../plugins/reviews/functions/embeds.js";

export type WebPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

export type WebReviewStatus = "published" | "hidden" | "deleted";

export type WebReview = {
  id: number;
  rating: number;
  content: string;
  anonymous: boolean;
  status: WebReviewStatus;
  channelId: string | null;
  messageId: string | null;
  /** Jump link to the review's Discord post, when it has one. */
  messageUrl: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hiddenAt: string | null;
  featuredAt: string | null;
  reply: string | null;
  replyAt: string | null;
  replyBy: WebPerson | null;
  hiddenBy: WebPerson | null;
  user: WebPerson;
};

/** Which reviews the list shows. "active" (published + hidden) is kept for older callers. */
export const REVIEW_SCOPES = ["published", "featured", "unreplied", "hidden", "deleted", "active", "all"] as const;
export type WebReviewScope = (typeof REVIEW_SCOPES)[number];
export const REVIEW_SORTS = ["newest", "oldest", "highest", "lowest"] as const;
export type WebReviewSort = (typeof REVIEW_SORTS)[number];

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_REVIEW_REPLY = 1000;

export type WebReviewsQuery = {
  q: string;
  rating: number | null;
  userId: string | null;
  scope: WebReviewScope;
  sort: WebReviewSort;
  limit: number;
  offset: number;
};

export function parseWebReviewsQuery(url: URL): WebReviewsQuery {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const ratingRaw = url.searchParams.get("rating");
  const rating = ratingRaw ? Number(ratingRaw) : null;
  const scopeRaw = url.searchParams.get("scope") ?? "";
  const deleted = url.searchParams.get("deleted");
  // Older callers: deleted=true meant "include deleted" (all), deleted=only just those.
  const scope: WebReviewScope = (REVIEW_SCOPES as readonly string[]).includes(scopeRaw)
    ? (scopeRaw as WebReviewScope)
    : deleted === "only"
      ? "deleted"
      : deleted === "true"
        ? "all"
        : "published";
  const sortRaw = url.searchParams.get("sort") ?? "";
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    rating: rating != null && rating >= 1 && rating <= 5 ? rating : null,
    userId: url.searchParams.get("user")?.trim() || null,
    scope,
    sort: (REVIEW_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as WebReviewSort) : "newest",
    limit,
    offset,
  };
}

export async function resolvePerson(guild: Guild, userId: string): Promise<WebPerson> {
  const member = await fetchMemberCached(guild, userId);
  const user = member?.user ?? (await fetchUserCached(guild.client, userId));
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

const isPublished = () => and(isNull(reviews.deletedAt), isNull(reviews.hiddenAt))!;

function scopeFilter(scope: WebReviewScope): SQL | null {
  switch (scope) {
    case "published":
      return isPublished();
    case "featured":
      return and(isPublished(), isNotNull(reviews.featuredAt))!;
    case "unreplied":
      return and(isPublished(), or(isNull(reviews.reply), eq(reviews.reply, ""))!)!;
    case "hidden":
      return and(isNull(reviews.deletedAt), isNotNull(reviews.hiddenAt))!;
    case "deleted":
      return isNotNull(reviews.deletedAt);
    case "active":
      return isNull(reviews.deletedAt);
    default:
      return null;
  }
}

function statusOf(row: Pick<Review, "deletedAt" | "hiddenAt">): WebReviewStatus {
  if (row.deletedAt) return "deleted";
  if (row.hiddenAt) return "hidden";
  return "published";
}

type PersonCache = Map<string, Promise<WebPerson>>;

function personFrom(guild: Guild, cache: PersonCache) {
  return (id: string) => {
    let hit = cache.get(id);
    if (!hit) {
      hit = resolvePerson(guild, id);
      cache.set(id, hit);
    }
    return hit;
  };
}

async function toWeb(guild: Guild, row: Review, cache: PersonCache): Promise<WebReview> {
  const person = personFrom(guild, cache);
  return {
    id: row.id,
    rating: row.rating,
    content: row.content,
    anonymous: row.anonymous,
    status: statusOf(row),
    channelId: row.channelId,
    messageId: row.messageId,
    messageUrl:
      row.channelId && row.messageId ? `https://discord.com/channels/${guild.id}/${row.channelId}/${row.messageId}` : null,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
    deletedAt: toIso(row.deletedAt),
    hiddenAt: toIso(row.hiddenAt),
    featuredAt: toIso(row.featuredAt),
    reply: row.reply?.trim() ? row.reply : null,
    replyAt: toIso(row.replyAt),
    replyBy: row.replyBy ? await person(row.replyBy) : null,
    hiddenBy: row.hiddenBy ? await person(row.hiddenBy) : null,
    user: await person(row.userId),
  };
}

function rowToReview(row: typeof reviews.$inferSelect): Review {
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
    reply: row.reply ?? null,
    replyBy: row.replyBy ?? null,
    replyAt: row.replyAt ?? null,
    hiddenAt: row.hiddenAt ?? null,
    hiddenBy: row.hiddenBy ?? null,
    featuredAt: row.featuredAt ?? null,
    featuredBy: row.featuredBy ?? null,
  };
}

export type WebReviewStats = {
  published: number;
  hidden: number;
  deleted: number;
  featured: number;
  replied: number;
  unreplied: number;
  /** Average of published reviews (0 when there are none). */
  average: number;
  /** Published reviews per star rating, index 0 = 1 star. */
  distribution: [number, number, number, number, number];
  last7d: number;
  last30d: number;
  /** Average of published reviews written in the last 30 days (0 when none). */
  average30d: number;
  /** New reviews per day, oldest first, last 30 days (today last). */
  daily: number[];
};

/** Whole-server numbers for the stat tiles (no filters applied). */
export async function getWebReviewStats(guild: Guild): Promise<WebReviewStats> {
  const db = getDb();
  const [row] = await db
    .select({
      published: sql<number>`sum(case when ${reviews.deletedAt} is null and ${reviews.hiddenAt} is null then 1 else 0 end)`,
      hidden: sql<number>`sum(case when ${reviews.deletedAt} is null and ${reviews.hiddenAt} is not null then 1 else 0 end)`,
      deleted: sql<number>`sum(case when ${reviews.deletedAt} is not null then 1 else 0 end)`,
      featured: sql<number>`sum(case when ${reviews.deletedAt} is null and ${reviews.hiddenAt} is null and ${reviews.featuredAt} is not null then 1 else 0 end)`,
      replied: sql<number>`sum(case when ${reviews.deletedAt} is null and ${reviews.hiddenAt} is null and coalesce(${reviews.reply}, '') <> '' then 1 else 0 end)`,
    })
    .from(reviews)
    .where(eq(reviews.guildId, guild.id));
  const ratingRows = await db
    .select({ rating: reviews.rating, n: count() })
    .from(reviews)
    .where(and(eq(reviews.guildId, guild.id), isPublished()))
    .groupBy(reviews.rating);
  const distribution: WebReviewStats["distribution"] = [0, 0, 0, 0, 0];
  let sum = 0;
  let rated = 0;
  for (const r of ratingRows) {
    if (r.rating >= 1 && r.rating <= 5) {
      distribution[r.rating - 1] = r.n;
      sum += r.rating * r.n;
      rated += r.n;
    }
  }

  const now = Date.now();
  const since30 = new Date(now - 30 * DAY_MS);
  const recent = await db
    .select({ at: reviews.createdAt, rating: reviews.rating, deletedAt: reviews.deletedAt, hiddenAt: reviews.hiddenAt })
    .from(reviews)
    .where(and(eq(reviews.guildId, guild.id), gte(reviews.createdAt, since30)));
  const daily = new Array<number>(30).fill(0);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  let last7d = 0;
  let sum30 = 0;
  let rated30 = 0;
  for (const r of recent) {
    const at = r.at.getTime();
    if (at >= now - 7 * DAY_MS) last7d++;
    const daysAgo = at >= todayStart.getTime() ? 0 : Math.ceil((todayStart.getTime() - at) / DAY_MS);
    const index = 29 - daysAgo;
    if (index >= 0 && index < 30) daily[index]! += 1;
    if (!r.deletedAt && !r.hiddenAt) {
      sum30 += r.rating;
      rated30++;
    }
  }

  const published = Number(row?.published ?? 0);
  const replied = Number(row?.replied ?? 0);
  return {
    published,
    hidden: Number(row?.hidden ?? 0),
    deleted: Number(row?.deleted ?? 0),
    featured: Number(row?.featured ?? 0),
    replied,
    unreplied: Math.max(0, published - replied),
    average: rated ? sum / rated : 0,
    distribution,
    last7d,
    last30d: recent.length,
    average30d: rated30 ? sum30 / rated30 : 0,
    daily,
  };
}

export async function listWebReviews(guild: Guild, query: WebReviewsQuery) {
  const filters: SQL[] = [eq(reviews.guildId, guild.id)];
  if (query.rating != null) filters.push(eq(reviews.rating, query.rating));
  if (query.userId) filters.push(eq(reviews.userId, query.userId));
  if (query.q) {
    const q = query.q;
    if (/^\d{17,20}$/.test(q)) filters.push(eq(reviews.userId, q));
    else if (/^#?\d+$/.test(q)) {
      const id = Number(q.replace("#", ""));
      filters.push(or(eq(reviews.id, id), like(reviews.content, `%${q}%`))!);
    } else filters.push(or(like(reviews.content, `%${q}%`), like(reviews.reply, `%${q}%`))!);
  }
  const db = getDb();
  // Per-scope counts for the status chips, under every filter except the scope itself.
  const [scopeCounts] = await db
    .select({
      published: sql<number>`sum(case when ${reviews.deletedAt} is null and ${reviews.hiddenAt} is null then 1 else 0 end)`,
      featured: sql<number>`sum(case when ${reviews.deletedAt} is null and ${reviews.hiddenAt} is null and ${reviews.featuredAt} is not null then 1 else 0 end)`,
      unreplied: sql<number>`sum(case when ${reviews.deletedAt} is null and ${reviews.hiddenAt} is null and coalesce(${reviews.reply}, '') = '' then 1 else 0 end)`,
      hidden: sql<number>`sum(case when ${reviews.deletedAt} is null and ${reviews.hiddenAt} is not null then 1 else 0 end)`,
      deleted: sql<number>`sum(case when ${reviews.deletedAt} is not null then 1 else 0 end)`,
      all: count(),
    })
    .from(reviews)
    .where(and(...filters));
  const scope = scopeFilter(query.scope);
  if (scope) filters.push(scope);
  const where = and(...filters)!;
  const [totalRow] = await db.select({ value: count() }).from(reviews).where(where);
  const order =
    query.sort === "oldest"
      ? [asc(reviews.id)]
      : query.sort === "highest"
        ? [desc(reviews.rating), desc(reviews.id)]
        : query.sort === "lowest"
          ? [asc(reviews.rating), desc(reviews.id)]
          : [desc(reviews.id)];
  const rows = await db
    .select()
    .from(reviews)
    .where(where)
    .orderBy(...order)
    .limit(query.limit)
    .offset(query.offset);

  const cache: PersonCache = new Map();
  const counts = {
    published: Number(scopeCounts?.published ?? 0),
    featured: Number(scopeCounts?.featured ?? 0),
    unreplied: Number(scopeCounts?.unreplied ?? 0),
    hidden: Number(scopeCounts?.hidden ?? 0),
    deleted: Number(scopeCounts?.deleted ?? 0),
    all: Number(scopeCounts?.all ?? 0),
  };
  const stats = await getWebReviewStats(guild);
  return {
    reviews: await Promise.all(rows.map((row) => toWeb(guild, rowToReview(row), cache))),
    total: Number(totalRow?.value ?? 0),
    limit: query.limit,
    offset: query.offset,
    average: stats.average,
    ratedCount: stats.published,
    counts: { ...counts, active: counts.published + counts.hidden },
    stats,
  };
}

export async function getWebReview(guild: Guild, reviewId: number) {
  const row = await getReviewById(guild.id, reviewId);
  if (!row) return null;
  const cache: PersonCache = new Map();
  const review = await toWeb(guild, row, cache);
  // The member's other reviews here (an edit keeps one review; deleting lets them write another).
  const others = await getDb()
    .select({ id: reviews.id, rating: reviews.rating, createdAt: reviews.createdAt, deletedAt: reviews.deletedAt, hiddenAt: reviews.hiddenAt })
    .from(reviews)
    .where(and(eq(reviews.guildId, guild.id), eq(reviews.userId, row.userId)))
    .orderBy(desc(reviews.id))
    .limit(20);
  const config = zReviewsConfig.safeParse(
    (await configManager.getEffectiveConfig(guild.id)).plugins?.reviews?.config ?? {},
  );
  return {
    review,
    others: others
      .filter((o) => o.id !== row.id)
      .map((o) => ({ id: o.id, rating: o.rating, createdAt: toIso(o.createdAt)!, status: statusOf(o) })),
    reviewChannelId: config.success ? (config.data.review_channel_id ?? null) : null,
  };
}

async function reviewChannelId(guildId: string): Promise<string | undefined> {
  const config = zReviewsConfig.safeParse((await configManager.getEffectiveConfig(guildId)).plugins?.reviews?.config ?? {});
  return config.success ? config.data.review_channel_id : undefined;
}

export type WebReviewAction = "reply" | "hide" | "unhide" | "feature" | "unfeature";

/**
 * Staff actions from the dashboard. Every change is mirrored to the review's Discord post
 * (edited, taken down when hidden, posted again when unhidden, pinned when featured).
 */
export async function actOnWebReview(
  guild: Guild,
  reviewId: number,
  action: WebReviewAction,
  staffId: string,
  body: { reply?: unknown },
): Promise<{ ok: true; review: WebReview; note: string | null } | { ok: false; status: number; error: string }> {
  const existing = await getReviewById(guild.id, reviewId);
  if (!existing) return { ok: false, status: 404, error: "Review not found" };
  if (existing.deletedAt) return { ok: false, status: 409, error: "This review was deleted." };

  const now = new Date();
  let patch: Parameters<typeof updateReview>[1];
  switch (action) {
    case "reply": {
      const text = typeof body.reply === "string" ? body.reply.trim().slice(0, MAX_REVIEW_REPLY) : "";
      patch = text ? { reply: text, replyBy: staffId, replyAt: now } : { reply: null, replyBy: null, replyAt: null };
      break;
    }
    case "hide":
      if (existing.hiddenAt) return { ok: false, status: 409, error: "This review is already hidden." };
      patch = { hiddenAt: now, hiddenBy: staffId };
      break;
    case "unhide":
      if (!existing.hiddenAt) return { ok: false, status: 409, error: "This review isn't hidden." };
      patch = { hiddenAt: null, hiddenBy: null };
      break;
    case "feature":
      if (existing.hiddenAt) return { ok: false, status: 409, error: "Show the review again before featuring it." };
      patch = { featuredAt: now, featuredBy: staffId };
      break;
    case "unfeature":
      patch = { featuredAt: null, featuredBy: null };
      break;
  }
  // Hiding also un-features, so a hidden review never comes back pinned by surprise.
  if (action === "hide") patch = { ...patch, featuredAt: null, featuredBy: null };
  // updateReview bumps updatedAt, which the post's footer shows as "edited"; keep the member's own time.
  const updated = await updateReview(existing.id, patch);
  if (!updated) return { ok: false, status: 404, error: "Review not found" };
  await getDb().update(reviews).set({ updatedAt: existing.updatedAt }).where(eq(reviews.id, existing.id)).run();
  updated.updatedAt = existing.updatedAt;

  const synced = await syncReviewPost(guild.client, guild.id, updated, await reviewChannelId(guild.id));
  return { ok: true, review: await toWeb(guild, synced.review, new Map()), note: synced.note };
}

export async function deleteWebReview(guild: Guild, reviewId: number) {
  const review = await softDeleteReview(guild.id, reviewId);
  // Same as /review delete: the Discord post goes too, not just the dashboard row.
  if (review) await deleteReviewPost(guild.client, guild.id, review);
  return review;
}
