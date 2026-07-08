import { and, eq, lte } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { reminders } from "../../../db/schema.js";

export type ReminderRow = {
  id: number;
  guildId: string;
  userId: string;
  channelId: string;
  message: string;
  remindAt: Date;
  createdAt: Date;
};

export async function createReminder(input: {
  guildId: string;
  userId: string;
  channelId: string;
  message: string;
  delayMinutes: number;
}): Promise<ReminderRow> {
  const remindAt = new Date(Date.now() + input.delayMinutes * 60_000);
  const row = await getDb()
    .insert(reminders)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      channelId: input.channelId,
      message: input.message,
      remindAt,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return row;
}

export async function listReminders(guildId: string, userId: string): Promise<ReminderRow[]> {
  return getDb()
    .select()
    .from(reminders)
    .where(and(eq(reminders.guildId, guildId), eq(reminders.userId, userId)))
    .all();
}

export async function cancelReminder(guildId: string, userId: string, id: number): Promise<boolean> {
  const result = await getDb()
    .delete(reminders)
    .where(and(eq(reminders.guildId, guildId), eq(reminders.userId, userId), eq(reminders.id, id)))
    .returning()
    .get();
  return Boolean(result);
}

export async function getDueReminders(now = new Date()): Promise<ReminderRow[]> {
  return getDb().select().from(reminders).where(lte(reminders.remindAt, now)).all();
}

export async function removeReminder(id: number): Promise<void> {
  await getDb().delete(reminders).where(eq(reminders.id, id));
}
