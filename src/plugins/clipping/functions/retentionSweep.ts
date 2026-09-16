import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { voiceClips, voiceClipParticipants } from "../../../db/schema.js";
import { deleteClipFile } from "./export.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("clipping");

/** Bounded per pass, matching contentRetentionSweep.ts's ARCHIVE_BATCH_SIZE convention — any rows
 *  not reached this time are caught on the next hourly pass. */
const SWEEP_BATCH_SIZE = 500;

/** How long a soft-deleted clip's row survives before being hard-deleted, so an in-flight page
 *  view that loaded the clip just before it expired still gets a clean "not found" instead of
 *  racing a DELETE mid-request. */
const HARD_DELETE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Deletes the mp4 for expired, non-kept clips and soft-deletes their row; separately
 *  hard-deletes rows that have been soft-deleted past the grace period. */
export async function sweepExpiredVoiceClips(): Promise<void> {
  const db = getDb();
  const now = new Date();

  const expired = await db
    .select()
    .from(voiceClips)
    .where(
      and(
        isNotNull(voiceClips.expiresAt),
        lt(voiceClips.expiresAt, now),
        eq(voiceClips.keepForever, false),
        isNull(voiceClips.deletedAt),
      ),
    )
    .limit(SWEEP_BATCH_SIZE)
    .all();

  for (const clip of expired) {
    deleteClipFile(clip.guildId, clip.id);
    await db.update(voiceClips).set({ deletedAt: now }).where(eq(voiceClips.id, clip.id));
  }
  if (expired.length > 0) log.info(`Retention sweep: expired ${expired.length} voice clip(s).`);

  const graceCutoff = new Date(now.getTime() - HARD_DELETE_GRACE_MS);
  const toHardDelete = await db
    .select({ id: voiceClips.id })
    .from(voiceClips)
    .where(and(isNotNull(voiceClips.deletedAt), lt(voiceClips.deletedAt, graceCutoff)))
    .limit(SWEEP_BATCH_SIZE)
    .all();

  for (const { id } of toHardDelete) {
    await db.delete(voiceClipParticipants).where(eq(voiceClipParticipants.clipId, id));
    await db.delete(voiceClips).where(eq(voiceClips.id, id));
  }
  if (toHardDelete.length > 0) log.info(`Retention sweep: hard-deleted ${toHardDelete.length} expired voice clip row(s).`);
}
