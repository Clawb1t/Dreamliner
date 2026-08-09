import { and, count, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import type { Guild } from "discord.js";
import { getDb } from "../db/client.js";
import { modCases } from "../db/schema.js";
import { INFRACTION_TYPES } from "../config/schemas/infraction.js";

export type WebPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

export type WebModCase = {
  id: number;
  type: string;
  reason: string | null;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
  user: WebPerson;
  mod: WebPerson;
  metadata?: Record<string, unknown> | null;
};

const CASE_TYPES = [...INFRACTION_TYPES, "clean"] as const;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type WebModCasesQuery = {
  q: string;
  type: string | null;
  active: boolean | null;
  targetUserId: string | null;
  modId: string | null;
  limit: number;
  offset: number;
};

export function parseWebModCasesQuery(url: URL): WebModCasesQuery {
  const activeRaw = url.searchParams.get("active");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const type = url.searchParams.get("type")?.trim() || null;
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    type: type && CASE_TYPES.includes(type as (typeof CASE_TYPES)[number]) ? type : type,
    active: activeRaw === "true" ? true : activeRaw === "false" ? false : null,
    targetUserId: url.searchParams.get("target")?.trim() || null,
    modId: url.searchParams.get("mod")?.trim() || null,
    limit,
    offset,
  };
}

async function resolvePerson(guild: Guild, userId: string): Promise<WebPerson> {
  if (!userId || userId === "0") {
    return { id: userId || "0", name: "Unknown", username: null, avatar: null };
  }
  const member = await guild.members.fetch(userId).catch(() => null);
  const user =
    member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  return {
    id: userId,
    name: member?.displayName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

async function resolvePeopleMap(guild: Guild, ids: string[]): Promise<Map<string, WebPerson>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const entries = await Promise.all(unique.map(async (id) => [id, await resolvePerson(guild, id)] as const));
  return new Map(entries);
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
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

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function buildFilters(guildId: string, query: WebModCasesQuery): SQL[] {
  const filters: SQL[] = [eq(modCases.guildId, guildId)];

  if (query.type) filters.push(eq(modCases.type, query.type));
  if (query.active != null) filters.push(eq(modCases.active, query.active));
  if (query.targetUserId) filters.push(eq(modCases.userId, query.targetUserId));
  if (query.modId) filters.push(eq(modCases.modId, query.modId));

  const q = query.q;
  if (q) {
    const idNum = Number(q.replace(/^#/, ""));
    if (!Number.isNaN(idNum) && idNum > 0 && String(idNum) === q.replace(/^#/, "")) {
      filters.push(eq(modCases.id, idNum));
    } else if (/^\d{17,20}$/.test(q)) {
      filters.push(or(eq(modCases.userId, q), eq(modCases.modId, q))!);
    } else {
      filters.push(
        or(
          like(modCases.reason, `%${q}%`),
          like(modCases.type, `%${q}%`),
          sql`cast(${modCases.id} as text) like ${`%${q}%`}`,
        )!,
      );
    }
  }

  return filters;
}

export async function listWebModCases(guild: Guild, query: WebModCasesQuery) {
  const db = getDb();
  const where = and(...buildFilters(guild.id, query))!;

  const [totalRow] = await db.select({ value: count() }).from(modCases).where(where);
  const rows = await db
    .select()
    .from(modCases)
    .where(where)
    .orderBy(desc(modCases.id))
    .limit(query.limit)
    .offset(query.offset);

  const people = await resolvePeopleMap(
    guild,
    rows.flatMap((row) => [row.userId, row.modId]),
  );

  const cases: WebModCase[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    reason: row.reason,
    active: row.active,
    expiresAt: toIso(row.expiresAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    user: people.get(row.userId) ?? {
      id: row.userId,
      name: row.userId,
      username: null,
      avatar: null,
    },
    mod: people.get(row.modId) ?? {
      id: row.modId,
      name: row.modId,
      username: null,
      avatar: null,
    },
  }));

  return {
    cases,
    total: Number(totalRow?.value ?? 0),
    limit: query.limit,
    offset: query.offset,
    types: [...CASE_TYPES],
  };
}

export async function getWebModCase(guild: Guild, caseId: number) {
  const db = getDb();
  const row = await db
    .select()
    .from(modCases)
    .where(and(eq(modCases.guildId, guild.id), eq(modCases.id, caseId)))
    .get();

  if (!row) return null;

  const [user, mod] = await Promise.all([
    resolvePerson(guild, row.userId),
    resolvePerson(guild, row.modId),
  ]);

  const detail: WebModCase = {
    id: row.id,
    type: row.type,
    reason: row.reason,
    active: row.active,
    expiresAt: toIso(row.expiresAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    user,
    mod,
    metadata: parseMetadata(row.metadata),
  };

  return detail;
}
