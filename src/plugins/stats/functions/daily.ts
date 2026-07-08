import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildStatsDaily } from "../../../db/schema.js";

export function statDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

type DailyField = "messages" | "joins" | "leaves";

export async function incrementDailyStat(guildId: string, field: DailyField): Promise<void> {
  const db = getDb();
  const date = statDate();
  const base = { guildId, statDate: date, messages: 0, joins: 0, leaves: 0 };
  base[field] = 1;

  const column =
    field === "messages" ? guildStatsDaily.messages : field === "joins" ? guildStatsDaily.joins : guildStatsDaily.leaves;

  await db
    .insert(guildStatsDaily)
    .values(base)
    .onConflictDoUpdate({
      target: [guildStatsDaily.guildId, guildStatsDaily.statDate],
      set: { [field]: sql`${column} + 1` },
    });
}

export type DailyStatRow = {
  statDate: string;
  messages: number;
  joins: number;
  leaves: number;
};

export async function getRecentDailyStats(guildId: string, days = 7): Promise<DailyStatRow[]> {
  const db = getDb();
  const rows = await db.select().from(guildStatsDaily).where(eq(guildStatsDaily.guildId, guildId));
  return rows
    .sort((a, b) => b.statDate.localeCompare(a.statDate))
    .slice(0, days)
    .map((row) => ({
      statDate: row.statDate,
      messages: row.messages,
      joins: row.joins,
      leaves: row.leaves,
    }));
}

export async function getDailyTotals(guildId: string): Promise<{ messages: number; joins: number; leaves: number }> {
  const db = getDb();
  const rows = await db.select().from(guildStatsDaily).where(eq(guildStatsDaily.guildId, guildId));
  return rows.reduce(
    (acc, row) => ({
      messages: acc.messages + row.messages,
      joins: acc.joins + row.joins,
      leaves: acc.leaves + row.leaves,
    }),
    { messages: 0, joins: 0, leaves: 0 },
  );
}
