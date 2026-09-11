import type { Client } from "discord.js";
import { fetchLatestUpload } from "./youtube.js";
import { listAllEnabledWatchers, touchLastChecked, updateCheckpoint } from "./store.js";
import { sendNotification } from "./notify.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getLogger } from "../../../core/logger.js";
const log = getLogger("social");

/**
 * Polled every few minutes by the scheduler (see plugin `onLoad`). Checks every enabled watcher
 * across every guild for a new upload; per-watcher failures are logged and skipped so one bad
 * channel/key doesn't stop the batch.
 *
 * The dashboard lets you manage watchers regardless of the plugin's enabled state (same as
 * Autoreactions — configuring isn't gated, only acting is), so this is the one place that
 * actually has to check `plugins.social.enabled` per guild before sending anything.
 */
export async function pollAllWatchers(client: Client): Promise<void> {
  const watchers = await listAllEnabledWatchers();
  if (!watchers.length) return;

  const enabledGuildIds = new Set<string>();
  const disabledGuildIds = new Set<string>();

  for (const watcher of watchers) {
    if (!enabledGuildIds.has(watcher.guildId) && !disabledGuildIds.has(watcher.guildId)) {
      const guildConfig = await configManager.getEffectiveConfig(watcher.guildId).catch(() => null);
      const isEnabled = guildConfig ? pluginEnabled(guildConfig, "social") : false;
      (isEnabled ? enabledGuildIds : disabledGuildIds).add(watcher.guildId);
    }
    if (disabledGuildIds.has(watcher.guildId)) continue;

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
      log.error(`[social] poll failed for watcher ${watcher.id} (guild ${watcher.guildId}):`, error);
    }
  }
}
