import type { Client } from "discord.js";
import { fetchLiveStream } from "./twitch.js";
import { listAllEnabledTwitchWatchers, touchTwitchLastChecked, updateTwitchCheckpoint } from "./storeTwitch.js";
import { sendTwitchNotification } from "./notifyTwitch.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getLogger } from "../../../core/logger.js";
const log = getLogger("social");

/**
 * Polled every couple of minutes by the scheduler (see plugin `onLoad`) — more often than
 * YouTube since "went live" is more time-sensitive than a new upload. Twitch assigns a
 * new stream id to every broadcast session, so a changed id (while live) is what signals a new
 * "went live" event; going offline doesn't clear the checkpoint, so a brief reconnect that reuses
 * the same id doesn't re-notify. Per-watcher failures are logged and skipped, same as poll.ts.
 */
export async function pollAllTwitchWatchers(client: Client): Promise<void> {
  const watchers = await listAllEnabledTwitchWatchers();
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
      const stream = await fetchLiveStream(watcher.sourceUserId);
      if (!stream) {
        await touchTwitchLastChecked(watcher.id);
        continue;
      }

      if (stream.streamId === watcher.lastStreamId) {
        await touchTwitchLastChecked(watcher.id);
        continue;
      }

      await sendTwitchNotification(client, watcher, stream);
      await updateTwitchCheckpoint(watcher.id, { lastStreamId: stream.streamId, lastLiveAt: stream.startedAt });
    } catch (error) {
      log.error(`[social] twitch poll failed for watcher ${watcher.id} (guild ${watcher.guildId}):`, error);
    }
  }
}
