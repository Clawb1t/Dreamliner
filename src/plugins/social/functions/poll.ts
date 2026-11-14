import type { Client } from "discord.js";
import { fetchLatestUpload, fetchVideoDetails, probeShort, type LatestUpload, type VideoDetails } from "./youtube.js";
import { listAllEnabledWatchers, touchLastChecked, updateCheckpoint, type SocialWatcherRow } from "./store.js";
import { sendNotification } from "./notify.js";
import { latestDelivery, recordDelivery } from "./deliveries.js";
import {
  SHORTS_MAX_SECONDS,
  classifyUpload,
  inQuietHours,
  resolveTypeMessage,
  uploadKindEnabled,
  uploadKindLabel,
  withinCooldown,
} from "./logic.js";
import type { YoutubeUploadKind } from "../../../config/schemas/social.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getLogger } from "../../../core/logger.js";
const log = getLogger("social");

type Classified = { kind: YoutubeUploadKind; label: string; details: VideoDetails | null };

/** One videos.list call (1 unit) per new upload, plus a free Shorts URL check for short videos. */
async function classify(videoId: string): Promise<Classified> {
  const details = (await fetchVideoDetails([videoId]).catch(() => new Map<string, VideoDetails>())).get(videoId) ?? null;
  if (!details) return { kind: "video", label: "video", details: null };
  const maybeShort =
    details.liveBroadcastContent === "none" &&
    !details.hasLiveStreamingDetails &&
    details.durationSeconds !== null &&
    details.durationSeconds > 0 &&
    details.durationSeconds <= SHORTS_MAX_SECONDS;
  const kind = classifyUpload({
    liveBroadcastContent: details.liveBroadcastContent,
    hasLiveStreamingDetails: details.hasLiveStreamingDetails,
    durationSeconds: details.durationSeconds,
    shortsProbe: maybeShort ? await probeShort(videoId) : null,
  });
  return { kind, label: uploadKindLabel(kind, details.liveBroadcastContent), details };
}

async function notifyUpload(client: Client, watcher: SocialWatcherRow, latest: LatestUpload, classified: Classified): Promise<void> {
  const { options } = watcher;
  if (!uploadKindEnabled(options, classified.kind)) return;

  const typed = resolveTypeMessage(options, classified.kind, watcher);
  let silent = inQuietHours(options);
  if (!silent && options.cooldown_minutes > 0) {
    const last = await latestDelivery("youtube", watcher.id).catch(() => null);
    silent = withinCooldown(last?.createdAt, options.cooldown_minutes);
  }

  const upload = { ...latest, thumbnailUrl: classified.details?.thumbnailUrl ?? latest.thumbnailUrl, typeLabel: classified.label };
  const message = await sendNotification(client, watcher, upload, { ...typed, silent });
  if (!message) return;
  await recordDelivery({
    platform: "youtube",
    watcherId: watcher.id,
    guildId: watcher.guildId,
    channelId: message.channelId,
    messageId: message.id,
    kind: classified.kind,
    itemId: latest.videoId,
    title: latest.title,
    url: latest.url,
    thumbnailUrl: upload.thumbnailUrl,
  }).catch((error: unknown) => log.warn(`[social] watcher ${watcher.id}: couldn't log the delivery:`, error));
}

/**
 * Polled every few minutes by the scheduler (see plugin `onLoad`). Checks every enabled watcher
 * across every guild for a new upload; per-watcher failures are logged and skipped so one bad
 * channel/key doesn't stop the batch.
 *
 * Quota: one playlistItems call (1 unit) per tracked channel per pass, shared by every server
 * tracking the same channel, plus one videos.list call (1 unit) per new upload to tell videos,
 * Shorts and livestreams apart.
 *
 * The dashboard lets you manage watchers regardless of the plugin's enabled state, so this is the
 * one place that has to check `plugins.social.enabled` per guild before sending anything.
 */
export async function pollAllWatchers(client: Client): Promise<void> {
  const watchers = await listAllEnabledWatchers();
  if (!watchers.length) return;

  const enabledGuildIds = new Set<string>();
  const disabledGuildIds = new Set<string>();
  const latestByPlaylist = new Map<string, Promise<LatestUpload | null>>();
  const classifiedByVideo = new Map<string, Promise<Classified>>();

  for (const watcher of watchers) {
    if (!enabledGuildIds.has(watcher.guildId) && !disabledGuildIds.has(watcher.guildId)) {
      const guildConfig = await configManager.getEffectiveConfig(watcher.guildId).catch(() => null);
      const isEnabled = guildConfig ? pluginEnabled(guildConfig, "social") : false;
      (isEnabled ? enabledGuildIds : disabledGuildIds).add(watcher.guildId);
    }
    if (disabledGuildIds.has(watcher.guildId)) continue;

    try {
      let latestPromise = latestByPlaylist.get(watcher.uploadsPlaylistId);
      if (!latestPromise) {
        latestPromise = fetchLatestUpload(watcher.uploadsPlaylistId);
        latestByPlaylist.set(watcher.uploadsPlaylistId, latestPromise);
      }
      const latest = await latestPromise;
      if (!latest || latest.videoId === watcher.lastVideoId) {
        await touchLastChecked(watcher.id);
        continue;
      }

      // The newest upload was deleted or made private, so an older one is on top again: move the
      // checkpoint without announcing it a second time.
      const older = watcher.lastVideoPublishedAt && latest.publishedAt.getTime() < watcher.lastVideoPublishedAt.getTime();
      await updateCheckpoint(watcher.id, { lastVideoId: latest.videoId, lastVideoPublishedAt: latest.publishedAt });
      if (older) continue;

      let classified = classifiedByVideo.get(latest.videoId);
      if (!classified) {
        classified = classify(latest.videoId);
        classifiedByVideo.set(latest.videoId, classified);
      }
      await notifyUpload(client, watcher, latest, await classified);
    } catch (error) {
      log.error(`[social] poll failed for watcher ${watcher.id} (guild ${watcher.guildId}):`, error);
    }
  }
}
