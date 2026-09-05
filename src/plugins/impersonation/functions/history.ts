import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { impersonationHistory } from "../../../db/schema.js";

export type IdentityField = "username" | "display_name" | "nickname" | "avatar" | "joined";

export type IdentityHistoryEntry = {
  id: number;
  guildId: string;
  userId: string;
  field: IdentityField;
  oldValue: string | null;
  newValue: string | null;
  changedAt: number;
};

function toEntry(row: typeof impersonationHistory.$inferSelect): IdentityHistoryEntry {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    field: row.field as IdentityField,
    oldValue: row.oldValue,
    newValue: row.newValue,
    changedAt: row.changedAt.getTime(),
  };
}

export async function recordIdentityChange(input: {
  guildId: string;
  userId: string;
  field: IdentityField;
  oldValue?: string | null;
  newValue?: string | null;
}): Promise<void> {
  if (input.field !== "joined" && input.oldValue === input.newValue) return;
  await getDb().insert(impersonationHistory).values({
    guildId: input.guildId,
    userId: input.userId,
    field: input.field,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    changedAt: new Date(),
  });
}

export async function getIdentityHistory(
  guildId: string,
  userId: string,
  limit = 25,
): Promise<IdentityHistoryEntry[]> {
  const rows = await getDb()
    .select()
    .from(impersonationHistory)
    .where(and(eq(impersonationHistory.guildId, guildId), eq(impersonationHistory.userId, userId)))
    .orderBy(desc(impersonationHistory.changedAt))
    .limit(limit);
  return rows.map(toEntry);
}
