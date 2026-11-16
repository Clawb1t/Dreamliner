import { and, asc, count, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { memberIdentity } from "../../../db/schema.js";

export type MemberIdentitySnapshot = {
  guildId: string;
  userId: string;
  nickname: string;
  roleIds: string[];
  timeoutUntil: number | null;
  username: string;
  updatedAt: Date;
};

function parseRoleIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function fromRow(row: {
  guildId: string;
  userId: string;
  nickname: string;
  roleIds: string;
  timeoutUntil: number | null;
  username: string;
  updatedAt: Date;
}): MemberIdentitySnapshot {
  return {
    guildId: row.guildId,
    userId: row.userId,
    nickname: row.nickname,
    roleIds: parseRoleIds(row.roleIds),
    timeoutUntil: row.timeoutUntil,
    username: row.username,
    updatedAt: row.updatedAt,
  };
}

export async function getMemberIdentity(
  guildId: string,
  userId: string,
): Promise<MemberIdentitySnapshot | null> {
  const row = await getDb()
    .select()
    .from(memberIdentity)
    .where(and(eq(memberIdentity.guildId, guildId), eq(memberIdentity.userId, userId)))
    .get();
  return row ? fromRow(row) : null;
}

export async function upsertMemberIdentity(input: {
  guildId: string;
  userId: string;
  nickname: string;
  roleIds: string[];
  timeoutUntil: number | null;
  username: string;
}): Promise<void> {
  const updatedAt = new Date();
  const roleIds = JSON.stringify(input.roleIds);
  await getDb()
    .insert(memberIdentity)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      nickname: input.nickname,
      roleIds,
      timeoutUntil: input.timeoutUntil,
      username: input.username,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [memberIdentity.guildId, memberIdentity.userId],
      set: {
        nickname: input.nickname,
        roleIds,
        timeoutUntil: input.timeoutUntil,
        username: input.username,
        updatedAt,
      },
    });
}

/** Removes one member's snapshot in one server. Resolves true when there was one. */
export async function deleteMemberIdentity(guildId: string, userId: string): Promise<boolean> {
  const result = await getDb()
    .delete(memberIdentity)
    .where(and(eq(memberIdentity.guildId, guildId), eq(memberIdentity.userId, userId)))
    .run();
  return result.changes > 0;
}

export type MemberIdentityListFilter = "all" | "roles" | "nickname" | "timeout" | "empty";
export type MemberIdentityListSort = "recent" | "oldest" | "roles" | "name";

export type MemberIdentityListQuery = {
  q: string;
  filter: MemberIdentityListFilter;
  sort: MemberIdentityListSort;
  limit: number;
  offset: number;
};

export type MemberIdentityStats = {
  total: number;
  withRoles: number;
  withNickname: number;
  activeTimeouts: number;
  updatedLast7d: number;
};

/** Number of saved role ids, from the JSON array column (SQLite JSON1). */
const roleCountSql = sql<number>`coalesce(json_array_length(${memberIdentity.roleIds}), 0)`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** One page of a server's snapshots (only that server's rows), plus the matching total. */
export async function listMemberIdentities(
  guildId: string,
  query: MemberIdentityListQuery,
  now = Date.now(),
): Promise<{ total: number; rows: Array<MemberIdentitySnapshot & { roleCount: number }> }> {
  const conditions: SQL[] = [eq(memberIdentity.guildId, guildId)];
  const q = query.q.trim();
  if (q) {
    const pattern = `%${escapeLike(q.toLowerCase())}%`;
    const match = or(
      eq(memberIdentity.userId, q),
      sql`lower(${memberIdentity.username}) LIKE ${pattern} ESCAPE '\\'`,
      sql`lower(${memberIdentity.nickname}) LIKE ${pattern} ESCAPE '\\'`,
    );
    if (match) conditions.push(match);
  }
  if (query.filter === "roles") conditions.push(sql`${roleCountSql} > 0`);
  else if (query.filter === "nickname") conditions.push(sql`${memberIdentity.nickname} <> ''`);
  else if (query.filter === "timeout") conditions.push(sql`${memberIdentity.timeoutUntil} > ${now}`);
  else if (query.filter === "empty") {
    conditions.push(sql`${roleCountSql} = 0`, sql`${memberIdentity.nickname} = ''`);
  }
  const where = and(...conditions);

  const order =
    query.sort === "oldest"
      ? [asc(memberIdentity.updatedAt)]
      : query.sort === "roles"
        ? [desc(roleCountSql), desc(memberIdentity.updatedAt)]
        : query.sort === "name"
          ? [sql`lower(${memberIdentity.username}) ASC`, asc(memberIdentity.userId)]
          : [desc(memberIdentity.updatedAt)];

  const db = getDb();
  const [countRow, rows] = await Promise.all([
    db.select({ n: count() }).from(memberIdentity).where(where).get(),
    db
      .select({
        guildId: memberIdentity.guildId,
        userId: memberIdentity.userId,
        nickname: memberIdentity.nickname,
        roleIds: memberIdentity.roleIds,
        timeoutUntil: memberIdentity.timeoutUntil,
        username: memberIdentity.username,
        updatedAt: memberIdentity.updatedAt,
        roleCount: roleCountSql,
      })
      .from(memberIdentity)
      .where(where)
      .orderBy(...order)
      .limit(query.limit)
      .offset(query.offset),
  ]);
  return {
    total: countRow?.n ?? 0,
    rows: rows.map((row) => ({ ...fromRow(row), roleCount: Number(row.roleCount) || 0 })),
  };
}

/** Totals for the stats row, for one server. */
export async function getMemberIdentityStats(guildId: string, now = Date.now()): Promise<MemberIdentityStats> {
  const weekAgo = Math.floor((now - 7 * 86_400_000) / 1000);
  const row = await getDb()
    .select({
      total: count(),
      withRoles: sql<number>`coalesce(sum(case when ${roleCountSql} > 0 then 1 else 0 end), 0)`,
      withNickname: sql<number>`coalesce(sum(case when ${memberIdentity.nickname} <> '' then 1 else 0 end), 0)`,
      activeTimeouts: sql<number>`coalesce(sum(case when ${memberIdentity.timeoutUntil} > ${now} then 1 else 0 end), 0)`,
      updatedLast7d: sql<number>`coalesce(sum(case when ${memberIdentity.updatedAt} >= ${weekAgo} then 1 else 0 end), 0)`,
    })
    .from(memberIdentity)
    .where(eq(memberIdentity.guildId, guildId))
    .get();
  return {
    total: Number(row?.total) || 0,
    withRoles: Number(row?.withRoles) || 0,
    withNickname: Number(row?.withNickname) || 0,
    activeTimeouts: Number(row?.activeTimeouts) || 0,
    updatedLast7d: Number(row?.updatedLast7d) || 0,
  };
}
