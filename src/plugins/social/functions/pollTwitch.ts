import type { Client } from "discord.js";
import { fetchLiveStreams, fetchStreamVod, type LiveStream } from "./twitch.js";
import {
  clearTwitchSeenLive,
  listAllEnabledTwitchWatchers,
  markTwitchSeenLive,
  touchTwitchLastChecked,
  updateTwitchCheckpoint,
  type SocialTwitchWatcherRow,
} from "./storeTwitch.js";
import { buildStreamEndedPayload, buildTwitchNotificationPayload, sendTwitchNotification } from "./notifyTwitch.js";
import { deleteNotification, editNotification, sendFollowUp } from "./notifyShared.js";
import { latestDelivery, openTwitchSession, recordDelivery, updateDelivery, type SocialDeliveryRow } from "./deliveries.js";
import { buildStreamSummary, inQuietHours, streamHasEnded, withinCooldown } from "./logic.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getLogger } from "../../../core/logger.js";
const log = getLogger("social");

/**
 * Handle the end of a live session: mark its delivery ended, then edit the live message into a
 * summary, post a summary reply, or delete it, depending on the creator's `end_action`.
 */
export async function finishTwitchSession(
  client: Client,
  watcher: SocialTwitchWatcherRow,
  session: SocialDeliveryRow,
  endedAt: Date,
): Promise<void> {
  await updateDelivery(session.id, { endedAt });
  const action = watcher.options.end_action;
  if (action === "none" || !session.messageId) return;

  if (action === "delete") {
    await deleteNotification(client, session.guildId, session.channelId, session.messageId);
    return;
  }

  const vodUrl = await fetchStreamVod(watcher.sourceUserId, session.itemId).catch(() => null);
  const summary = buildStreamSummary({
    streamerName: watcher.sourceUserDisplayName,
    title: session.title,
    gameName: session.gameName,
    startedAt: session.startedAt ?? session.createdAt,
    endedAt,
    peakViewers: session.peakViewers,
    vodUrl,
    channelUrl: watcher.sourceUserUrl,
  });
  const payload = buildStreamEndedPayload(watcher, summary);
  if (action === "edit") {
    await editNotification(client, session.guildId, session.channelId, session.messageId, payload);
  } else {
    await sendFollowUp(client, session.guildId, session.channelId, payload, session.messageId);
  }
}

/** Still live on the same session: track peak viewers and, if asked, keep title/category current. */
async function updateOngoing(client: Client, watcher: SocialTwitchWatcherRow, stream: LiveStream): Promise<void> {
  const { options } = watcher;
  if (options.end_action === "none" && !options.live_updates) return;
  const session = await openTwitchSession(watcher.id);
  if (!session || session.itemId !== stream.streamId) return;

  const changed = stream.title !== session.title || stream.gameName !== (session.gameName ?? "");
  const patch: Parameters<typeof updateDelivery>[1] = {};
  if (stream.viewerCount > session.peakViewers) patch.peakViewers = stream.viewerCount;
  if (changed) {
    patch.title = stream.title;
    patch.gameName = stream.gameName;
  }
  await updateDelivery(session.id, patch);

  if (changed && options.live_updates && session.messageId) {
    await editNotification(client, session.guildId, session.channelId, session.messageId, buildTwitchNotificationPayload(watcher, stream));
  }
}

/**
 * A new stream id inside the cooldown after the last one: keep using the previous message instead
 * of notifying again. If that message was already turned into a summary, it becomes live again.
 */
async function continueSession(client: Client, watcher: SocialTwitchWatcherRow, stream: LiveStream): Promise<void> {
  const previous = (await openTwitchSession(watcher.id)) ?? (await latestDelivery("twitch", watcher.id));
  if (!previous) return;
  await updateDelivery(previous.id, {
    itemId: stream.streamId,
    title: stream.title,
    gameName: stream.gameName,
    endedAt: null,
  });
  if (previous.endedAt && previous.messageId && watcher.options.end_action === "edit") {
    await editNotification(client, previous.guildId, previous.channelId, previous.messageId, buildTwitchNotificationPayload(watcher, stream));
  }
}

async function handleWatcher(client: Client, watcher: SocialTwitchWatcherRow, stream: LiveStream | undefined): Promise<void> {
  const now = new Date();

  if (!stream) {
    // Offline. Once they have been gone past the grace period, the session is over.
    if (watcher.lastSeenLiveAt && streamHasEnded(watcher.lastSeenLiveAt, now)) {
      const session = await openTwitchSession(watcher.id);
      if (session) await finishTwitchSession(client, watcher, session, watcher.lastSeenLiveAt);
      await clearTwitchSeenLive(watcher.id);
    }
    await touchTwitchLastChecked(watcher.id);
    return;
  }

  if (stream.streamId === watcher.lastStreamId) {
    await markTwitchSeenLive(watcher.id, now);
    await updateOngoing(client, watcher, stream);
    return;
  }

  // A new session. Twitch gives every broadcast a new stream id.
  const { options } = watcher;
  const lastLive = watcher.lastSeenLiveAt ?? watcher.lastLiveAt;
  if (options.cooldown_minutes > 0 && withinCooldown(lastLive, options.cooldown_minutes, now)) {
    await updateTwitchCheckpoint(watcher.id, { lastStreamId: stream.streamId, lastLiveAt: stream.startedAt });
    await markTwitchSeenLive(watcher.id, now);
    await continueSession(client, watcher, stream);
    return;
  }

  // Close out a previous session that never saw its offline poll (e.g. the bot was down).
  const stale = await openTwitchSession(watcher.id);
  if (stale) await finishTwitchSession(client, watcher, stale, watcher.lastSeenLiveAt ?? stale.createdAt);

  await updateTwitchCheckpoint(watcher.id, { lastStreamId: stream.streamId, lastLiveAt: stream.startedAt });
  await markTwitchSeenLive(watcher.id, now);

  const message = await sendTwitchNotification(client, watcher, stream, { silent: inQuietHours(options, now) });
  if (!message) return;
  await recordDelivery({
    platform: "twitch",
    watcherId: watcher.id,
    guildId: watcher.guildId,
    channelId: message.channelId,
    messageId: message.id,
    kind: "stream",
    itemId: stream.streamId,
    title: stream.title,
    url: stream.url,
    thumbnailUrl: stream.thumbnailUrl || null,
    gameName: stream.gameName,
    peakViewers: stream.viewerCount,
    startedAt: stream.startedAt,
  });
}

/**
 * Polled every couple of minutes by the scheduler (see plugin `onLoad`). Live status for every
 * tracked streamer comes from one batched Helix /streams call per 100 streamers. A changed stream
 * id while live is a new "went live" event; going offline for a few minutes ends the session
 * (which may edit, summarise or delete the live message). Per-watcher failures are logged and
 * skipped, same as poll.ts.
 */
export async function pollAllTwitchWatchers(client: Client): Promise<void> {
  const all = await listAllEnabledTwitchWatchers();
  if (!all.length) return;

  const guildEnabled = new Map<string, boolean>();
  const watchers: SocialTwitchWatcherRow[] = [];
  for (const watcher of all) {
    if (!guildEnabled.has(watcher.guildId)) {
      const guildConfig = await configManager.getEffectiveConfig(watcher.guildId).catch(() => null);
      guildEnabled.set(watcher.guildId, guildConfig ? pluginEnabled(guildConfig, "social") : false);
    }
    if (guildEnabled.get(watcher.guildId)) watchers.push(watcher);
  }
  if (!watchers.length) return;

  let streams: Map<string, LiveStream>;
  try {
    streams = await fetchLiveStreams(watchers.map((w) => w.sourceUserId));
  } catch (error) {
    // Without live status nobody can be judged offline, so skip the whole pass.
    log.error("[social] twitch live status check failed:", error);
    return;
  }

  for (const watcher of watchers) {
    try {
      await handleWatcher(client, watcher, streams.get(watcher.sourceUserId));
    } catch (error) {
      log.error(`[social] twitch poll failed for watcher ${watcher.id} (guild ${watcher.guildId}):`, error);
    }
  }
}
