import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { nameHistory } from "../../../db/schema.js";

export type NameChangeType = "nickname" | "username";

export async function recordNameChange(input: {
  guildId: string;
  userId: string;
  oldName: string;
  newName: string;
  changeType: NameChangeType;
}): Promise<void> {
  if (input.oldName === input.newName) return;
  const db = getDb();
  await db.insert(nameHistory).values({
    guildId: input.guildId,
    userId: input.userId,
    oldName: input.oldName,
    newName: input.newName,
    changeType: input.changeType,
    changedAt: new Date(),
  });
}

export type NameHistoryEntry = {
  id: number;
  guildId: string;
  userId: string;
  oldName: string;
  newName: string;
  changeType: string;
  changedAt: Date;
};

function rowToEntry(row: typeof nameHistory.$inferSelect): NameHistoryEntry {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    oldName: row.oldName,
    newName: row.newName,
    changeType: row.changeType,
    changedAt: row.changedAt,
  };
}

export async function getUserNameHistory(guildId: string, userId: string, limit = 15): Promise<NameHistoryEntry[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(nameHistory)
    .where(and(eq(nameHistory.guildId, guildId), eq(nameHistory.userId, userId)))
    .orderBy(desc(nameHistory.changedAt))
    .limit(limit);
  return rows.map(rowToEntry);
}

export async function searchNameHistory(guildId: string, query: string, limit = 15): Promise<NameHistoryEntry[]> {
  const db = getDb();
  const trimmed = query.trim();
  if (!trimmed) {
    const rows = await db
      .select()
      .from(nameHistory)
      .where(eq(nameHistory.guildId, guildId))
      .orderBy(desc(nameHistory.changedAt))
      .limit(limit);
    return rows.map(rowToEntry);
  }

  const pattern = `%${trimmed}%`;
  const rows = await db
    .select()
    .from(nameHistory)
    .where(
      and(
        eq(nameHistory.guildId, guildId),
        or(
          eq(nameHistory.userId, trimmed),
          like(nameHistory.oldName, pattern),
          like(nameHistory.newName, pattern),
        ),
      ),
    )
    .orderBy(desc(nameHistory.changedAt))
    .limit(limit);
  return rows.map(rowToEntry);
}
