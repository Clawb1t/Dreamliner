/** Wrapped's own per-user rows, for "erase my data", the data export and the erase preview. */
import { count, eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { musicPlayLog, wrappedCommandUsage, wrappedEmojiUsage } from "../../db/schema.js";
import { dropPendingCommandsFor } from "./commands.js";
import { dropPendingEmojiFor } from "./emoji.js";

export function countUserWrappedData(userId: string): { emoji: number; music: number; commands: number } {
  const db = getDb();
  const total = (row: { total: number } | undefined) => Number(row?.total ?? 0);
  return {
    emoji: total(db.select({ total: count() }).from(wrappedEmojiUsage).where(eq(wrappedEmojiUsage.userId, userId)).get()),
    music: total(db.select({ total: count() }).from(musicPlayLog).where(eq(musicPlayLog.userId, userId)).get()),
    commands: total(db.select({ total: count() }).from(wrappedCommandUsage).where(eq(wrappedCommandUsage.userId, userId)).get()),
  };
}

export function exportUserWrappedData(userId: string) {
  const db = getDb();
  return {
    emoji: db.select().from(wrappedEmojiUsage).where(eq(wrappedEmojiUsage.userId, userId)).all(),
    music: db.select().from(musicPlayLog).where(eq(musicPlayLog.userId, userId)).all(),
    commands: db.select().from(wrappedCommandUsage).where(eq(wrappedCommandUsage.userId, userId)).all(),
  };
}

/** Deletes the user's emoji counts, music play history and command counts, including any not yet
 *  written. Returns the number of rows removed per kind. */
export function deleteUserWrappedData(userId: string): { emoji: number; music: number; commands: number } {
  dropPendingEmojiFor(userId);
  dropPendingCommandsFor(userId);
  const db = getDb();
  return {
    emoji: db.delete(wrappedEmojiUsage).where(eq(wrappedEmojiUsage.userId, userId)).run().changes,
    music: db.delete(musicPlayLog).where(eq(musicPlayLog.userId, userId)).run().changes,
    commands: db.delete(wrappedCommandUsage).where(eq(wrappedCommandUsage.userId, userId)).run().changes,
  };
}
