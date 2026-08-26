import { and, desc, isNotNull, ne, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildUserTrail, messageArchives } from "../db/schema.js";
import type { ArchivedMessage } from "./types.js";
import { getContentRetentionDays, isContentExpired, REDACTED_CONTENT_PLACEHOLDER } from "./contentRetention.js";

/** How many archive rows to (re-)check per sweep pass — bounded so one pass never gets slow;
 * any rows not reached this time are caught on the next pass (interval task re-runs). */
const ARCHIVE_BATCH_SIZE = 500;

/** Clears `guild_user_trail.snippet` on rows whose author's retention window has passed
 * (or, for authors with 0-day retention, on all their rows — catches a user who just
 * turned retention off after already having snippets stored). */
export async function sweepUserTrailSnippets(): Promise<number> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ userId: guildUserTrail.userId })
    .from(guildUserTrail)
    .where(and(isNotNull(guildUserTrail.snippet), ne(guildUserTrail.snippet, "")))
    .all();

  let cleared = 0;
  for (const { userId } of rows) {
    const retentionDays = await getContentRetentionDays(userId);
    const trails = await db
      .select({ id: guildUserTrail.id, endedAt: guildUserTrail.endedAt, snippet: guildUserTrail.snippet })
      .from(guildUserTrail)
      .where(and(eq(guildUserTrail.userId, userId), ne(guildUserTrail.snippet, "")))
      .all();

    for (const trail of trails) {
      if (!isContentExpired(trail.endedAt, retentionDays)) continue;
      await db.update(guildUserTrail).set({ snippet: "" }).where(eq(guildUserTrail.id, trail.id));
      cleared += 1;
    }
  }
  return cleared;
}

/** Redacts expired-per-author message content inside `message_archives.payload` JSON blobs. */
export async function sweepMessageArchives(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select()
    .from(messageArchives)
    .orderBy(desc(messageArchives.createdAt))
    .limit(ARCHIVE_BATCH_SIZE)
    .all();

  let changedRows = 0;
  for (const row of rows) {
    let messages: ArchivedMessage[];
    try {
      messages = JSON.parse(row.payload) as ArchivedMessage[];
    } catch {
      continue;
    }

    let changed = false;
    const redacted = await Promise.all(
      messages.map(async (message) => {
        if (message.content === REDACTED_CONTENT_PLACEHOLDER) return message;
        const retentionDays = await getContentRetentionDays(message.authorId);
        const sentAt = new Date(message.createdAt);
        if (!isContentExpired(sentAt, retentionDays)) return message;
        changed = true;
        return { ...message, content: REDACTED_CONTENT_PLACEHOLDER };
      }),
    );

    if (changed) {
      await db
        .update(messageArchives)
        .set({ payload: JSON.stringify(redacted) })
        .where(eq(messageArchives.id, row.id));
      changedRows += 1;
    }
  }
  return changedRows;
}

export async function sweepExpiredMessageContent(): Promise<void> {
  await sweepUserTrailSnippets();
  await sweepMessageArchives();
}
