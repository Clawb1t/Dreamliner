import { and, eq } from "drizzle-orm";
import type { GuildMember } from "discord.js";
import { getDb } from "../../../db/client.js";
import { ticketBlacklist } from "../../../db/schema.js";

export type TicketBlacklistEntry = {
  guildId: string;
  targetId: string;
  targetType: "user" | "role";
  reason: string | null;
  createdAt: Date;
};

function rowToEntry(row: typeof ticketBlacklist.$inferSelect): TicketBlacklistEntry {
  return {
    guildId: row.guildId,
    targetId: row.targetId,
    targetType: row.targetType === "role" ? "role" : "user",
    reason: row.reason ?? null,
    createdAt: row.createdAt,
  };
}

export async function listBlacklist(guildId: string): Promise<TicketBlacklistEntry[]> {
  const db = getDb();
  const rows = await db.select().from(ticketBlacklist).where(eq(ticketBlacklist.guildId, guildId));
  return rows.map(rowToEntry);
}

export async function addToBlacklist(
  guildId: string,
  targetId: string,
  targetType: "user" | "role",
  reason?: string | null,
): Promise<void> {
  const db = getDb();
  await db
    .insert(ticketBlacklist)
    .values({ guildId, targetId, targetType, reason: reason ?? null, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [ticketBlacklist.guildId, ticketBlacklist.targetId],
      set: { targetType, reason: reason ?? null },
    });
}

export async function removeFromBlacklist(guildId: string, targetId: string): Promise<void> {
  const db = getDb();
  await db.delete(ticketBlacklist).where(and(eq(ticketBlacklist.guildId, guildId), eq(ticketBlacklist.targetId, targetId)));
}

/** Whether a member is blocked from opening tickets, directly or via one of their roles. */
export async function isBlacklisted(guildId: string, member: GuildMember): Promise<TicketBlacklistEntry | null> {
  const entries = await listBlacklist(guildId);
  const userEntry = entries.find((e) => e.targetType === "user" && e.targetId === member.id);
  if (userEntry) return userEntry;
  const roleEntry = entries.find((e) => e.targetType === "role" && member.roles.cache.has(e.targetId));
  return roleEntry ?? null;
}
