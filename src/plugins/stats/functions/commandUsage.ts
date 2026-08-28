import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { commandUsageDaily, commandUsageTotals } from "../../../db/schema.js";
import {
  dateRange,
  dateRangeInclusive,
  isAllTimeWindow,
  statDate,
  windowSince,
} from "./daily.js";

const MAX_COMMAND_NAME = 64;

/** Normalize a Discord / custom command name for storage. */
export function normalizeCommandName(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "")
    .slice(0, MAX_COMMAND_NAME);
}

/**
 * Record one successful command invocation.
 * Fire-and-forget safe: callers should not await in the hot path unless needed.
 */
export async function recordCommandUsage(guildId: string, commandName: string): Promise<void> {
  const name = normalizeCommandName(commandName);
  if (!guildId || !name) return;

  const db = getDb();
  const date = statDate();

  await Promise.all([
    db
      .insert(commandUsageDaily)
      .values({ guildId, commandName: name, statDate: date, uses: 1 })
      .onConflictDoUpdate({
        target: [
          commandUsageDaily.guildId,
          commandUsageDaily.commandName,
          commandUsageDaily.statDate,
        ],
        set: { uses: sql`${commandUsageDaily.uses} + 1` },
      }),
    db
      .insert(commandUsageTotals)
      .values({ guildId, commandName: name, uses: 1 })
      .onConflictDoUpdate({
        target: [commandUsageTotals.guildId, commandUsageTotals.commandName],
        set: { uses: sql`${commandUsageTotals.uses} + 1` },
      }),
  ]);
}

export function trackCommandUsage(guildId: string | null | undefined, commandName: string): void {
  if (!guildId) return;
  void recordCommandUsage(guildId, commandName).catch((error) => {
    console.warn(
      `[stats] failed to record command usage /${commandName}:`,
      error instanceof Error ? error.message : error,
    );
  });
}

export async function getGuildCommandUsesTotal(guildId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${commandUsageTotals.uses}), 0)` })
    .from(commandUsageTotals)
    .where(eq(commandUsageTotals.guildId, guildId))
    .get();
  return Number(row?.total ?? 0);
}

export async function getGlobalCommandUsesTotal(): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${commandUsageTotals.uses}), 0)` })
    .from(commandUsageTotals)
    .get();
  return Number(row?.total ?? 0);
}

export async function getTopGuildCommands(
  guildId: string,
  limit = 15,
): Promise<Array<{ commandName: string; count: number }>> {
  const db = getDb();
  const rows = await db
    .select({
      commandName: commandUsageTotals.commandName,
      count: commandUsageTotals.uses,
    })
    .from(commandUsageTotals)
    .where(eq(commandUsageTotals.guildId, guildId))
    .orderBy(desc(commandUsageTotals.uses))
    .limit(limit);
  return rows.map((row) => ({ commandName: row.commandName, count: row.count }));
}

export async function getTopGlobalCommands(
  limit = 15,
): Promise<Array<{ commandName: string; count: number }>> {
  const db = getDb();
  const rows = await db
    .select({
      commandName: commandUsageTotals.commandName,
      count: sql<number>`coalesce(sum(${commandUsageTotals.uses}), 0)`,
    })
    .from(commandUsageTotals)
    .groupBy(commandUsageTotals.commandName)
    .orderBy(desc(sql`coalesce(sum(${commandUsageTotals.uses}), 0)`))
    .limit(limit);
  return rows.map((row) => ({
    commandName: row.commandName,
    count: Number(row.count ?? 0),
  }));
}

export async function getTopGuildCommandsByDaily(
  guildId: string,
  days: number,
  limit = 15,
): Promise<Array<{ commandName: string; count: number }>> {
  if (isAllTimeWindow(days)) return getTopGuildCommands(guildId, limit);

  const db = getDb();
  const since = windowSince(days)!;
  const rows = await db
    .select({
      commandName: commandUsageDaily.commandName,
      count: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)`,
    })
    .from(commandUsageDaily)
    .where(and(eq(commandUsageDaily.guildId, guildId), gte(commandUsageDaily.statDate, since)))
    .groupBy(commandUsageDaily.commandName)
    .orderBy(desc(sql`coalesce(sum(${commandUsageDaily.uses}), 0)`))
    .limit(limit);

  return rows.map((row) => ({
    commandName: row.commandName,
    count: Number(row.count ?? 0),
  }));
}

export async function getTopGlobalCommandsByDaily(
  days: number,
  limit = 15,
): Promise<Array<{ commandName: string; count: number }>> {
  if (isAllTimeWindow(days)) return getTopGlobalCommands(limit);

  const db = getDb();
  const since = windowSince(days)!;
  const rows = await db
    .select({
      commandName: commandUsageDaily.commandName,
      count: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)`,
    })
    .from(commandUsageDaily)
    .where(gte(commandUsageDaily.statDate, since))
    .groupBy(commandUsageDaily.commandName)
    .orderBy(desc(sql`coalesce(sum(${commandUsageDaily.uses}), 0)`))
    .limit(limit);

  return rows.map((row) => ({
    commandName: row.commandName,
    count: Number(row.count ?? 0),
  }));
}

export async function getGuildCommandUsesInWindow(guildId: string, days: number): Promise<number> {
  if (isAllTimeWindow(days)) return getGuildCommandUsesTotal(guildId);
  const db = getDb();
  const since = windowSince(days)!;
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)` })
    .from(commandUsageDaily)
    .where(and(eq(commandUsageDaily.guildId, guildId), gte(commandUsageDaily.statDate, since)))
    .get();
  return Number(row?.total ?? 0);
}

export async function getGlobalCommandUsesInWindow(days: number): Promise<number> {
  if (isAllTimeWindow(days)) return getGlobalCommandUsesTotal();
  const db = getDb();
  const since = windowSince(days)!;
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)` })
    .from(commandUsageDaily)
    .where(gte(commandUsageDaily.statDate, since))
    .get();
  return Number(row?.total ?? 0);
}

export async function getFilledGuildCommandDailyUses(
  guildId: string,
  days = 14,
): Promise<Array<{ statDate: string; uses: number }>> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select({
        statDate: commandUsageDaily.statDate,
        uses: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)`,
      })
      .from(commandUsageDaily)
      .where(eq(commandUsageDaily.guildId, guildId))
      .groupBy(commandUsageDaily.statDate)
      .orderBy(asc(commandUsageDaily.statDate));
    if (rows.length === 0) return [];
    const dates = dateRangeInclusive(rows[0]!.statDate, statDate());
    const byDate = new Map(rows.map((row) => [row.statDate, Number(row.uses ?? 0)]));
    return dates.map((date) => ({ statDate: date, uses: byDate.get(date) ?? 0 }));
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select({
      statDate: commandUsageDaily.statDate,
      uses: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)`,
    })
    .from(commandUsageDaily)
    .where(and(eq(commandUsageDaily.guildId, guildId), gte(commandUsageDaily.statDate, since)))
    .groupBy(commandUsageDaily.statDate);

  const byDate = new Map(rows.map((row) => [row.statDate, Number(row.uses ?? 0)]));
  return dates.map((date) => ({ statDate: date, uses: byDate.get(date) ?? 0 }));
}

export async function getFilledGlobalCommandDailyUses(
  days = 14,
): Promise<Array<{ statDate: string; uses: number }>> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select({
        statDate: commandUsageDaily.statDate,
        uses: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)`,
      })
      .from(commandUsageDaily)
      .groupBy(commandUsageDaily.statDate)
      .orderBy(asc(commandUsageDaily.statDate));
    if (rows.length === 0) return [];
    const dates = dateRangeInclusive(rows[0]!.statDate, statDate());
    const byDate = new Map(rows.map((row) => [row.statDate, Number(row.uses ?? 0)]));
    return dates.map((date) => ({ statDate: date, uses: byDate.get(date) ?? 0 }));
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select({
      statDate: commandUsageDaily.statDate,
      uses: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)`,
    })
    .from(commandUsageDaily)
    .where(gte(commandUsageDaily.statDate, since))
    .groupBy(commandUsageDaily.statDate);

  const byDate = new Map(rows.map((row) => [row.statDate, Number(row.uses ?? 0)]));
  return dates.map((date) => ({ statDate: date, uses: byDate.get(date) ?? 0 }));
}
