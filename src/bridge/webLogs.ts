import { and, asc, count, desc, eq, gte, like, lte, or, sql, type SQL } from "drizzle-orm";
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
  caseId: number | null;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
};

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
    actorId: url.searchParams.get("actor")?.trim() || null,
    targetId: url.searchParams.get("target")?.trim() || null,
    caseId,
    from: url.searchParams.get("from")?.trim() || null,
    to: url.searchParams.get("to")?.trim() || null,
    limit,
    offset,
  };
}

async function resolvePerson(guild: Guild, userId: string | null | undefined): Promise<WebLogPerson | null> {
  if (!userId) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
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
