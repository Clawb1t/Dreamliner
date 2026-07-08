import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { scheduledPosts } from "../../../db/schema.js";

export type ScheduledPostRow = {
  id: number;
  guildId: string;
  channelId: string;
  content: string;
  cronExpr: string | null;
  nextRunAt: Date | null;
  createdBy: string;
  createdAt: Date;
};

export async function createScheduledPost(input: {
  guildId: string;
  channelId: string;
  content: string;
  delayMinutes: number;
  createdBy: string;
}): Promise<ScheduledPostRow> {
  const nextRunAt = new Date(Date.now() + input.delayMinutes * 60_000);
  const row = await getDb()
    .insert(scheduledPosts)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      content: input.content,
      nextRunAt,
      createdBy: input.createdBy,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return row;
}

export async function listScheduledPosts(guildId: string): Promise<ScheduledPostRow[]> {
  return getDb().select().from(scheduledPosts).where(eq(scheduledPosts.guildId, guildId)).all();
}

export async function deleteScheduledPost(guildId: string, id: number): Promise<boolean> {
  const result = await getDb()
    .delete(scheduledPosts)
    .where(and(eq(scheduledPosts.guildId, guildId), eq(scheduledPosts.id, id)))
    .returning()
    .get();
  return Boolean(result);
}

export async function getDueScheduledPosts(now = new Date()): Promise<ScheduledPostRow[]> {
  return getDb()
    .select()
    .from(scheduledPosts)
    .where(and(isNotNull(scheduledPosts.nextRunAt), lte(scheduledPosts.nextRunAt, now)))
    .all();
}

export async function removeScheduledPost(id: number): Promise<void> {
  await getDb().delete(scheduledPosts).where(eq(scheduledPosts.id, id));
}
