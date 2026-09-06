import { and, desc, isNotNull, ne, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildUserTrail, messageArchives } from "../db/schema.js";
import type { ArchivedMessage } from "./types.js";
import { getGuildContentRetentionDays, isContentExpired, REDACTED_CONTENT_PLACEHOLDER } from "./contentRetention.js";

/** How many archive rows to (re-)check per sweep pass, bounded so one pass never gets slow;
 * any rows not reached this time are caught on the next pass (interval task re-runs). */
const ARCHIVE_BATCH_SIZE = 500;

/** Clears `guild_user_trail.snippet` on rows whose guild's retention window has passed. */
export async function sweepUserTrailSnippets(): Promise<number> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ guildId: guildUserTrail.guildId })
    .from(guildUserTrail)
    .where(and(isNotNull(guildUserTrail.snippet), ne(guildUserTrail.snippet, "")))
    .all();

  let cleared = 0;
  for (const { guildId } of rows) {
    const retentionDays = await getGuildContentRetentionDays(guildId);
    const trails = await db
      .select({ id: guildUserTrail.id, endedAt: guildUserTrail.endedAt, snippet: guildUserTrail.snippet })
      .from(guildUserTrail)
      .where(and(eq(guildUserTrail.guildId, guildId), ne(guildUserTrail.snippet, "")))
      .all();

    for (const trail of trails) {
      if (!isContentExpired(trail.endedAt, retentionDays)) continue;
      await db.update(guildUserTrail).set({ snippet: "" }).where(eq(guildUserTrail.id, trail.id));
      cleared += 1;
    }
  }
  return cleared;
}

/** Redacts expired message content inside `message_archives.payload` JSON blobs, per the
 * archive's own guild's retention setting. */
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

    const retentionDays = await getGuildContentRetentionDays(row.guildId);
    let changed = false;
    const redacted = messages.map((message) => {
      if (message.content === REDACTED_CONTENT_PLACEHOLDER) return message;
      const sentAt = new Date(message.createdAt);
      if (!isContentExpired(sentAt, retentionDays)) return message;
      changed = true;
      return { ...message, content: REDACTED_CONTENT_PLACEHOLDER };
    });

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
