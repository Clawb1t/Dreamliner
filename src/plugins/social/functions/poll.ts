import type { Client } from "discord.js";
import { fetchLatestUpload } from "./youtube.js";
import { listAllEnabledWatchers, touchLastChecked, updateCheckpoint } from "./store.js";
import { sendNotification } from "./notify.js";

/**
 * Polled every few minutes by the scheduler (see plugin `onLoad`). Checks every enabled watcher
 * across every guild for a new upload; per-watcher failures are logged and skipped so one bad
 * channel/key doesn't stop the batch.
 */
export async function pollAllWatchers(client: Client): Promise<void> {
  const watchers = await listAllEnabledWatchers();
  if (!watchers.length) return;

  for (const watcher of watchers) {
    try {
      const latest = await fetchLatestUpload(watcher.uploadsPlaylistId);
      if (!latest) {
        await touchLastChecked(watcher.id);
        continue;
      }

      if (latest.videoId === watcher.lastVideoId) {
        await touchLastChecked(watcher.id);
        continue;
      }

      await sendNotification(client, watcher, latest);
      await updateCheckpoint(watcher.id, {
        lastVideoId: latest.videoId,
        lastVideoPublishedAt: latest.publishedAt,
      });
    } catch (error) {
      console.error(`[social] poll failed for watcher ${watcher.id} (guild ${watcher.guildId}):`, error);
    }
  }
}
