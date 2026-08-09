import { and, eq, gte, like, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { modCases } from "../../../db/schema.js";

export type ScamProtectDayCount = {
  day: string;
  count: number;
};

/** Softbans recorded by Scam Protect for this guild. */
export async function countScamProtectCatches(guildId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(modCases)
    .where(
      and(
        eq(modCases.guildId, guildId),
        eq(modCases.type, "softban"),
        like(modCases.metadata, "%scam_protect%"),
      ),
    )
    .get();
  return Number(row?.count ?? 0);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Daily catch counts for the last `days` days (inclusive of today), zero-filled. */
export async function listScamProtectCatchesByDay(
  guildId: string,
  days = 30,
): Promise<ScamProtectDayCount[]> {
  const db = getDb();
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  const rows = await db
    .select({
      day: sql<string>`strftime('%Y-%m-%d', datetime(${modCases.createdAt}, 'unixepoch'))`,
      count: sql<number>`count(*)`,
    })
    .from(modCases)
    .where(
      and(
        eq(modCases.guildId, guildId),
        eq(modCases.type, "softban"),
        like(modCases.metadata, "%scam_protect%"),
        gte(modCases.createdAt, since),
      ),
    )
    .groupBy(sql`strftime('%Y-%m-%d', datetime(${modCases.createdAt}, 'unixepoch'))`)
    .all();

  const byDay = new Map(rows.map((row) => [row.day, Number(row.count ?? 0)]));
  const out: ScamProtectDayCount[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    const key = dayKey(d);
    out.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}
