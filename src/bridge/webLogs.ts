import { and, asc, count, desc, eq, gte, inArray, isNotNull, like, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import type { Guild } from "discord.js";
import { getDb } from "../db/client.js";
import { guildLogEvents } from "../db/schema.js";
import {
  getLoggingEventGroups,
  LOG_EVENT_META,
  LOG_EVENT_TYPES,
  isLogEventType,
  type LogEventType,
} from "../core/logging/events.js";

export type WebLogPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

export type WebLogEvent = {
  id: string;
  category: string;
  eventType: string;
  eventLabel: string;
  title: string;
  summary: string;
  createdAt: string;
  actor: WebLogPerson | null;
  target: WebLogPerson | null;
  channelId: string | null;
  messageId: string | null;
  caseId: number | null;
  discordMessageId: string | null;
  payload?: Record<string, unknown> | null;
};

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type WebLogsQuery = {
  q: string;
  eventType: string | null;
  category: "server" | "moderation" | null;
  actorId: string | null;
  targetId: string | null;
  /** Either the actor or the target (the detail view's "related events for this member"). */
  userId: string | null;
  channelId: string | null;
  /** Several event types at once (the dashboard's category filters), validated against the catalogue. */
  eventTypes: LogEventType[] | null;
  caseId: number | null;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
};

const SNOWFLAKE_RE = /^\d{17,20}$/;

function snowflakeParam(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key)?.trim();
  return raw && SNOWFLAKE_RE.test(raw) ? raw : null;
}

/** A comma-separated list of event types, keeping only known types (bounded by the catalogue). */
function parseEventTypes(raw: string | null): LogEventType[] | null {
  if (!raw) return null;
  const types = [...new Set(raw.split(",").map((t) => t.trim()).filter(isLogEventType))].slice(0, LOG_EVENT_TYPES.length);
  return types.length ? types : null;
}

export function parseWebLogsQuery(url: URL): WebLogsQuery {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const categoryRaw = url.searchParams.get("category")?.trim();
  const caseRaw = url.searchParams.get("caseId")?.trim();
  const caseId = caseRaw && /^\d+$/.test(caseRaw) ? Number(caseRaw) : null;
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    eventType: url.searchParams.get("event_type")?.trim() || null,
    category:
      categoryRaw === "server" || categoryRaw === "moderation" ? categoryRaw : null,
    actorId: snowflakeParam(url, "actor"),
    targetId: snowflakeParam(url, "target"),
    userId: snowflakeParam(url, "user"),
    channelId: snowflakeParam(url, "channel"),
    eventTypes: parseEventTypes(url.searchParams.get("event_types")),
    caseId,
    from: url.searchParams.get("from")?.trim() || null,
    to: url.searchParams.get("to")?.trim() || null,
    limit,
    offset,
  };
}

async function resolvePerson(guild: Guild, userId: string | null | undefined): Promise<WebLogPerson | null> {
  if (!userId) return null;
  const member = await fetchMemberCached(guild, userId);
  const user = member?.user ?? (await fetchUserCached(guild.client, userId));
  return {
    id: userId,
    name: member?.displayName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

async function resolvePeopleMap(guild: Guild, ids: Array<string | null | undefined>): Promise<Map<string, WebLogPerson>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const entries = await Promise.all(unique.map(async (id) => [id, await resolvePerson(guild, id)] as const));
  return new Map(entries.filter((entry): entry is [string, WebLogPerson] => Boolean(entry[1])));
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

function toIso(value: Date | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function eventLabel(eventType: string): string {
  if (isLogEventType(eventType)) return LOG_EVENT_META[eventType].label;
  return eventType;
}

function buildFilters(guildId: string, query: WebLogsQuery): SQL[] {
  const filters: SQL[] = [eq(guildLogEvents.guildId, guildId)];

  if (query.eventType) filters.push(eq(guildLogEvents.eventType, query.eventType));
  if (query.category) filters.push(eq(guildLogEvents.category, query.category));
  if (query.actorId) filters.push(eq(guildLogEvents.actorId, query.actorId));
  if (query.targetId) filters.push(eq(guildLogEvents.targetId, query.targetId));
  if (query.userId) filters.push(or(eq(guildLogEvents.actorId, query.userId), eq(guildLogEvents.targetId, query.userId))!);
  if (query.channelId) filters.push(eq(guildLogEvents.channelId, query.channelId));
  if (query.eventTypes) filters.push(inArray(guildLogEvents.eventType, query.eventTypes));
  if (query.caseId != null) filters.push(eq(guildLogEvents.caseId, query.caseId));

  if (query.from) {
    const fromDate = new Date(query.from);
    if (!Number.isNaN(fromDate.getTime())) filters.push(gte(guildLogEvents.createdAt, fromDate));
  }
  if (query.to) {
    const toDate = new Date(query.to);
    if (!Number.isNaN(toDate.getTime())) filters.push(lte(guildLogEvents.createdAt, toDate));
  }

  const q = query.q;
  if (q) {
    if (/^\d{17,20}$/.test(q)) {
      filters.push(
        or(
          eq(guildLogEvents.actorId, q),
          eq(guildLogEvents.targetId, q),
          eq(guildLogEvents.channelId, q),
          eq(guildLogEvents.messageId, q),
        )!,
      );
    } else if (/^\d+$/.test(q)) {
      filters.push(or(eq(guildLogEvents.caseId, Number(q)), like(guildLogEvents.id, `%${q}%`))!);
    } else {
      filters.push(
        or(
          like(guildLogEvents.title, `%${q}%`),
          like(guildLogEvents.summary, `%${q}%`),
          like(guildLogEvents.eventType, `%${q}%`),
        )!,
      );
    }
  }

  return filters;
}

function mapRow(
  row: typeof guildLogEvents.$inferSelect,
  people: Map<string, WebLogPerson>,
  includePayload: boolean,
): WebLogEvent {
  return {
    id: row.id,
    category: row.category,
    eventType: row.eventType,
    eventLabel: eventLabel(row.eventType),
    title: row.title,
    summary: row.summary,
    createdAt: toIso(row.createdAt),
    actor: row.actorId
      ? people.get(row.actorId) ?? {
          id: row.actorId,
          name: row.actorId,
          username: null,
          avatar: null,
        }
      : null,
    target: row.targetId
      ? people.get(row.targetId) ?? {
          id: row.targetId,
          name: row.targetId,
          username: null,
          avatar: null,
        }
      : null,
    channelId: row.channelId,
    messageId: row.messageId,
    caseId: row.caseId,
    discordMessageId: row.discordMessageId,
    payload: includePayload ? parsePayload(row.payload) : undefined,
  };
}

export async function listWebLogs(guild: Guild, query: WebLogsQuery) {
  const db = getDb();
  const where = and(...buildFilters(guild.id, query))!;

  const [totalRow] = await db.select({ value: count() }).from(guildLogEvents).where(where);
  const rows = await db
    .select()
    .from(guildLogEvents)
    .where(where)
    .orderBy(desc(guildLogEvents.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  const people = await resolvePeopleMap(
    guild,
    rows.flatMap((row) => [row.actorId, row.targetId]),
  );

  return {
    logs: rows.map((row) => mapRow(row, people, false)),
    total: Number(totalRow?.value ?? 0),
    limit: query.limit,
    offset: query.offset,
    eventTypes: [...LOG_EVENT_TYPES],
    groups: getLoggingEventGroups(),
  };
}

export async function getWebLog(guild: Guild, logId: string) {
  const db = getDb();
  const row = await db
    .select()
    .from(guildLogEvents)
    .where(and(eq(guildLogEvents.guildId, guild.id), eq(guildLogEvents.id, logId)))
    .get();
  if (!row) return null;

  const people = await resolvePeopleMap(guild, [row.actorId, row.targetId]);
  return mapRow(row, people, true);
}

export async function getWebLogStats(guild: Guild, days = 14) {
  const safeDays = Math.min(90, Math.max(1, days || 14));
  const from = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const db = getDb();

  const byDay = await db
    .select({
      day: sql<string>`strftime('%Y-%m-%d', datetime(${guildLogEvents.createdAt}, 'unixepoch'))`,
      count: count(),
    })
    .from(guildLogEvents)
    .where(and(eq(guildLogEvents.guildId, guild.id), gte(guildLogEvents.createdAt, from)))
    .groupBy(sql`strftime('%Y-%m-%d', datetime(${guildLogEvents.createdAt}, 'unixepoch'))`)
    .orderBy(asc(sql`strftime('%Y-%m-%d', datetime(${guildLogEvents.createdAt}, 'unixepoch'))`));

  const byType = await db
    .select({
      eventType: guildLogEvents.eventType,
      count: count(),
    })
    .from(guildLogEvents)
    .where(and(eq(guildLogEvents.guildId, guild.id), gte(guildLogEvents.createdAt, from)))
    .groupBy(guildLogEvents.eventType)
    .orderBy(desc(count()))
    .limit(20);

  const [totalRow] = await db
    .select({ value: count() })
    .from(guildLogEvents)
    .where(and(eq(guildLogEvents.guildId, guild.id), gte(guildLogEvents.createdAt, from)));

  return {
    days: safeDays,
    total: Number(totalRow?.value ?? 0),
    byDay: byDay.map((row) => ({ day: row.day, count: Number(row.count) })),
    byType: byType.map((row) => ({
      eventType: row.eventType,
      label: eventLabel(row.eventType),
      count: Number(row.count),
    })),
  };
}

export function listLoggingEventCatalog() {
  return {
    eventTypes: [...LOG_EVENT_TYPES] as LogEventType[],
    groups: getLoggingEventGroups(),
  };
}

// --- Overview (the dashboard's Logs overview and category pages) ------------------------------------

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest range (and comparison range) one overview request may cover. */
export const LOG_OVERVIEW_MAX_SPAN = 731;
const HOURLY_MAX_DAYS = 2;
const TOP_ROWS = 10;

export type WebLogOverviewQuery = {
  from: string;
  to: string;
  compare: "none" | "prev" | "year";
  eventTypes: LogEventType[] | null;
};

function isIsoDay(value: string | null): value is string {
  if (!value || !ISO_DAY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function spanDaysIso(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function minusYearIso(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y - 1, m - 1, Math.min(d, m === 2 ? 28 : d))).toISOString().slice(0, 10);
}

/** Validates `?from=&to=&compare=&event_types=`; clamps the range to today and the max span. */
export function parseWebLogOverviewQuery(url: URL): WebLogOverviewQuery | { error: string } {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isIsoDay(from) || !isIsoDay(to)) return { error: "from and to must be YYYY-MM-DD dates" };
  if (from > to) return { error: "from must not be after to" };
  const today = new Date().toISOString().slice(0, 10);
  const end = to > today ? today : to;
  let start = from > end ? end : from;
  if (spanDaysIso(start, end) > LOG_OVERVIEW_MAX_SPAN) start = addDaysIso(end, -(LOG_OVERVIEW_MAX_SPAN - 1));
  const rawCompare = url.searchParams.get("compare");
  const compare = rawCompare === "prev" || rawCompare === "year" ? rawCompare : "none";
  return { from: start, to: end, compare, eventTypes: parseEventTypes(url.searchParams.get("event_types")) };
}

function dayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

const DAY_SQL = sql<string>`strftime('%Y-%m-%d', ${guildLogEvents.createdAt}, 'unixepoch')`;
const HOUR_SQL = sql<string>`strftime('%Y-%m-%dT%H', ${guildLogEvents.createdAt}, 'unixepoch')`;
const WEEKDAY_SQL = sql<string>`strftime('%w', ${guildLogEvents.createdAt}, 'unixepoch')`;
const HOUR_OF_DAY_SQL = sql<string>`strftime('%H', ${guildLogEvents.createdAt}, 'unixepoch')`;

/**
 * Counts for one guild's stored log events over an inclusive UTC day range: per day and event
 * type (and per hour for very short ranges), the comparison range's daily totals per type, a
 * weekday x hour grid, and the most frequent actors, targets and channels. Only this guild's rows
 * are read; people resolve through the same helper the log list uses, so nothing is shown here
 * that the list itself doesn't already show.
 */
export async function getWebLogOverview(guild: Guild, query: WebLogOverviewQuery) {
  const db = getDb();
  const scope = (from: string, to: string): SQL => {
    const parts: SQL[] = [
      eq(guildLogEvents.guildId, guild.id),
      gte(guildLogEvents.createdAt, dayStart(from)),
      lt(guildLogEvents.createdAt, dayStart(addDaysIso(to, 1))),
    ];
    if (query.eventTypes) parts.push(inArray(guildLogEvents.eventType, query.eventTypes));
    return and(...parts)!;
  };
  const where = scope(query.from, query.to);

  const compareRange =
    query.compare === "prev"
      ? (() => {
          const span = spanDaysIso(query.from, query.to);
          return { from: addDaysIso(query.from, -span), to: addDaysIso(query.from, -1) };
        })()
      : query.compare === "year"
        ? { from: minusYearIso(query.from), to: minusYearIso(query.to) }
        : null;

  const [earliestRow] = await db
    .select({ value: sql<number | null>`min(${guildLogEvents.createdAt})` })
    .from(guildLogEvents)
    .where(eq(guildLogEvents.guildId, guild.id));
  const earliestSec = earliestRow?.value != null ? Number(earliestRow.value) : null;
  const today = new Date().toISOString().slice(0, 10);
  const earliest = earliestSec != null ? new Date(earliestSec * 1000).toISOString().slice(0, 10) : today;

  const dayTypeRows = (w: SQL) =>
    db
      .select({ day: DAY_SQL, eventType: guildLogEvents.eventType, count: count() })
      .from(guildLogEvents)
      .where(w)
      .groupBy(DAY_SQL, guildLogEvents.eventType);

  const short = spanDaysIso(query.from, query.to) <= HOURLY_MAX_DAYS;

  const [byDayType, compareByDayType, byHourType, heat, actors, targets, channels] = await Promise.all([
    dayTypeRows(where),
    compareRange ? dayTypeRows(scope(compareRange.from, compareRange.to)) : Promise.resolve([]),
    short
      ? db
          .select({ hour: HOUR_SQL, eventType: guildLogEvents.eventType, count: count() })
          .from(guildLogEvents)
          .where(where)
          .groupBy(HOUR_SQL, guildLogEvents.eventType)
      : Promise.resolve([]),
    db
      .select({ weekday: WEEKDAY_SQL, hour: HOUR_OF_DAY_SQL, count: count() })
      .from(guildLogEvents)
      .where(where)
      .groupBy(WEEKDAY_SQL, HOUR_OF_DAY_SQL),
    db
      .select({ id: guildLogEvents.actorId, count: count() })
      .from(guildLogEvents)
      .where(and(where, isNotNull(guildLogEvents.actorId)))
      .groupBy(guildLogEvents.actorId)
      .orderBy(desc(count()))
      .limit(TOP_ROWS),
    db
      .select({ id: guildLogEvents.targetId, count: count() })
      .from(guildLogEvents)
      .where(and(where, isNotNull(guildLogEvents.targetId)))
      .groupBy(guildLogEvents.targetId)
      .orderBy(desc(count()))
      .limit(TOP_ROWS),
    db
      .select({ id: guildLogEvents.channelId, count: count() })
      .from(guildLogEvents)
      .where(and(where, isNotNull(guildLogEvents.channelId)))
      .groupBy(guildLogEvents.channelId)
      .orderBy(desc(count()))
      .limit(TOP_ROWS),
  ]);

  const people = await resolvePeopleMap(guild, [...actors.map((r) => r.id), ...targets.map((r) => r.id)]);
  const personRow = (row: { id: string | null; count: number }) => {
    const person = people.get(row.id!) ?? { id: row.id!, name: row.id!, username: null, avatar: null };
    return { ...person, count: Number(row.count) };
  };

  return {
    from: query.from,
    to: query.to,
    compare: compareRange,
    bounds: { earliest: earliest > today ? today : earliest, latest: today, maxSpanDays: LOG_OVERVIEW_MAX_SPAN },
    byDayType: byDayType.map((r) => ({ day: r.day, eventType: r.eventType, count: Number(r.count) })),
    compareByDayType: compareByDayType.map((r) => ({ day: r.day, eventType: r.eventType, count: Number(r.count) })),
    byHourType: byHourType.map((r) => ({ hour: r.hour, eventType: r.eventType, count: Number(r.count) })),
    heatmap: heat.map((r) => ({ weekday: Number(r.weekday), hour: Number(r.hour), value: Number(r.count) })),
    topActors: actors.map(personRow),
    topTargets: targets.map(personRow),
    topChannels: channels.map((r) => {
      const channel = guild.channels.cache.get(r.id!);
      return { id: r.id!, name: channel?.name ?? null, count: Number(r.count) };
    }),
  };
}
