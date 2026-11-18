/**
 * Twitch on the feeds engine. Live status for every followed streamer comes from one batched
 * Helix /streams call per 100 streamers every 2 minutes. Each broadcast is an item (keyed on the
 * stream id), so every server's "went live" post is deduped by the same unique delivery row as
 * any other feed. The live session itself (stream id, last seen live) lives on the source, since
 * it's the same for everyone; going offline for a few minutes ends it, which may edit, summarise
 * or delete each server's live message (its `end_action`).
 */
import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getLogger } from "../../../core/logger.js";
import { fetchLiveStreams, fetchStreamVod, type LiveStream } from "../functions/twitch.js";
import { inQuietHours, streamHasEnded, withinCooldown } from "../functions/logic.js";
import { deleteFeedMessage, discordSender, editFeedMessage, sendFollowUp, type Sender } from "./deliver.js";
import { buildFeedPayload, buildStreamEndedPayload } from "./render.js";
import {
  completeDelivery,
  failDelivery,
  getDeliveryFor,
  getItem,
  insertDelivery,
  latestPostedDelivery,
  listActiveTwitchSources,
  listEnabledSubscriptionsForSource,
  openTwitchSession,
  reserveDelivery,
  updateDeliveryPayload,
  updateItem,
  updateSource,
  upsertItem,
  type FeedDeliveryRow,
  type FeedItemRow,
  type FeedSourceRow,
  type FeedSubscriptionRow,
} from "./store.js";
import type { FeedItemInput } from "./types.js";
import { cleanTitle } from "./text.js";
const log = getLogger("social");

export const TWITCH_POLL_INTERVAL_MS = 2 * 60_000;

export function streamToItem(stream: LiveStream): FeedItemInput {
  return {
    key: stream.streamId,
    title: cleanTitle(stream.title, "Live now"),
    url: stream.url,
    imageUrl: stream.thumbnailUrl || null,
    summary: "",
    author: null,
    tags: stream.gameName ? [stream.gameName] : [],
    publishedAt: stream.startedAt,
    payload: { kind: "stream", gameName: stream.gameName, viewerCount: stream.viewerCount, startedAt: stream.startedAt.getTime() },
  };
}

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Mark a session ended, then edit / summarise / delete its message as the feed asks. */
export async function finishTwitchSession(
  client: Client,
  subscription: FeedSubscriptionRow,
  source: FeedSourceRow,
  session: FeedDeliveryRow,
  endedAt: Date,
): Promise<void> {
  await updateDeliveryPayload(session.id, { ...session.payload, endedAt: endedAt.getTime() });
  const action = subscription.options.end_action;
  if (action === "none" || !session.messageId) return;
  if (action === "delete") {
    await deleteFeedMessage(client, session.guildId, session.channelId, session.messageId);
    return;
  }
  const item = await getItem(session.itemId);
  const userId = str(source.config.userId);
  const vodUrl = item && userId ? await fetchStreamVod(userId, item.itemKey).catch(() => null) : null;
  const startedMs = num(session.payload.startedAt, session.createdAt.getTime());
  const payload = buildStreamEndedPayload(subscription.message, source, {
    streamerName: source.title,
    title: str(session.payload.title) || item?.title || "Stream",
    gameName: str(session.payload.gameName) || null,
    startedAt: new Date(startedMs),
    endedAt,
    peakViewers: num(session.payload.peakViewers),
    vodUrl,
    channelUrl: source.siteUrl ?? `https://www.twitch.tv/${str(source.config.login)}`,
  });
  if (action === "edit") await editFeedMessage(client, session.guildId, session.channelId, session.messageId, payload);
  else await sendFollowUp(client, session.guildId, session.channelId, payload, session.messageId);
}

/** Still live on the same session: track peak viewers and, if asked, keep the title/category current. */
async function updateOngoing(client: Client, subscription: FeedSubscriptionRow, source: FeedSourceRow, session: FeedDeliveryRow, item: FeedItemRow, stream: LiveStream): Promise<void> {
  const changed = stream.title !== str(session.payload.title) || stream.gameName !== str(session.payload.gameName);
  const peak = Math.max(num(session.payload.peakViewers), stream.viewerCount);
  if (!changed && peak === num(session.payload.peakViewers)) return;
  await updateDeliveryPayload(session.id, { ...session.payload, title: stream.title, gameName: stream.gameName, peakViewers: peak });
  if (changed && subscription.options.live_updates && session.messageId) {
    const payload = buildFeedPayload(subscription.message, source, item, { roleIds: subscription.mentionRoleIds });
    await editFeedMessage(client, session.guildId, session.channelId, session.messageId, payload);
  }
}

/** One subscription's reaction to a live stream it hasn't posted yet. */
async function handleNewStream(
  client: Client,
  subscription: FeedSubscriptionRow,
  source: FeedSourceRow,
  item: FeedItemRow,
  stream: LiveStream,
  previousSeenLiveAt: Date | null,
  send: Sender,
  now: Date,
): Promise<void> {
  // Already live when this feed was added (or the stream the old watcher had announced).
  if (item.baseline || item.id <= subscription.cursorItemId) return;
  const { options } = subscription;

  // A restart within the cooldown keeps using the previous message instead of notifying again.
  const previous = openTwitchSession(subscription.id) ?? (await latestPostedDelivery(subscription.id));
  const previousEnded = previous ? (typeof previous.payload.endedAt === "number" ? new Date(previous.payload.endedAt) : now) : null;
  const lastLive = previousSeenLiveAt ?? previousEnded;
  if (previous && options.cooldown_minutes > 0 && withinCooldown(lastLive, options.cooldown_minutes, now)) {
    await updateDeliveryPayload(previous.id, { ...previous.payload, endedAt: previous.payload.endedAt ?? now.getTime(), continuedBy: item.id });
    insertDelivery({
      subscriptionId: subscription.id,
      itemId: item.id,
      guildId: subscription.guildId,
      channelId: previous.channelId,
      messageId: previous.messageId,
      status: "continued",
      payload: { kind: "stream", title: stream.title, gameName: stream.gameName, peakViewers: stream.viewerCount, startedAt: num(previous.payload.startedAt, now.getTime()), endedAt: null, continuedFrom: previous.id },
    });
    if (typeof previous.payload.endedAt === "number" && previous.messageId && options.end_action === "edit") {
      await editFeedMessage(client, previous.guildId, previous.channelId, previous.messageId, buildFeedPayload(subscription.message, source, item, { roleIds: [] }));
    }
    return;
  }

  // Close out a previous session that never saw its offline poll (e.g. the bot was down).
  const stale = openTwitchSession(subscription.id);
  if (stale) await finishTwitchSession(client, subscription, source, stale, previousSeenLiveAt ?? stale.createdAt);

  const deliveryId = reserveDelivery(subscription, item.id, now);
  if (deliveryId === null) return;
  const payload = buildFeedPayload(subscription.message, source, item, { roleIds: subscription.mentionRoleIds, silent: inQuietHours(options, now) });
  const result = await send(subscription, payload);
  if ("error" in result) {
    failDelivery(deliveryId, result.error);
    return;
  }
  completeDelivery(deliveryId, result.messageId, result.channelId, {
    kind: "stream",
    title: stream.title,
    gameName: stream.gameName,
    peakViewers: stream.viewerCount,
    startedAt: stream.startedAt.getTime(),
    endedAt: null,
  });
}

/** Process one Twitch source against its current live status (undefined = offline). */
export async function handleTwitchSource(
  client: Client,
  source: FeedSourceRow,
  stream: LiveStream | undefined,
  subscriptions: FeedSubscriptionRow[],
  send: Sender,
  now: Date = new Date(),
): Promise<void> {
  const lastSeen = typeof source.state.lastSeenLiveAt === "number" ? new Date(source.state.lastSeenLiveAt) : null;

  if (!stream) {
    if (lastSeen && streamHasEnded(lastSeen, now)) {
      for (const subscription of subscriptions) {
        const session = openTwitchSession(subscription.id);
        if (session) await finishTwitchSession(client, subscription, source, session, lastSeen).catch((e: unknown) => log.warn("[social] twitch end failed:", e));
      }
      await updateSource(source.id, { state: { ...source.state, lastSeenLiveAt: null }, lastCheckedAt: now, lastOkAt: now });
    } else {
      await updateSource(source.id, { lastCheckedAt: now, lastOkAt: now });
    }
    return;
  }

  const item = await upsertItem(source.id, streamToItem(stream), false);
  const freshPayload = { ...item.payload, gameName: stream.gameName, viewerCount: stream.viewerCount };
  if (item.title !== cleanTitle(stream.title, "Live now") || item.payload.viewerCount !== stream.viewerCount) {
    await updateItem(item.id, { title: cleanTitle(stream.title, "Live now"), payload: freshPayload });
  }
  const current = { ...item, title: cleanTitle(stream.title, "Live now"), payload: freshPayload };
  const isNewStream = source.state.streamId !== stream.streamId;
  await updateSource(source.id, { state: { ...source.state, streamId: stream.streamId, lastSeenLiveAt: now.getTime() }, lastCheckedAt: now, lastOkAt: now });

  for (const subscription of subscriptions) {
    try {
      const existing = await getDeliveryFor(subscription.id, item.id);
      if (existing && (existing.status === "sent" || existing.status === "continued")) {
        await updateOngoing(client, subscription, source, existing, current, stream);
        continue;
      }
      if (existing && existing.status !== "failed" && existing.status !== "pending") continue;
      await handleNewStream(client, subscription, source, current, stream, isNewStream ? lastSeen : null, send, now);
    } catch (error) {
      log.error(`[social] twitch feed ${subscription.id} (guild ${subscription.guildId}) failed:`, error);
    }
  }
}

let running = false;

/** Every couple of minutes (plugin onLoad). Overlapping passes are skipped. */
export async function pollTwitchFeeds(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const sources = listActiveTwitchSources();
    if (!sources.length) return;
    let streams: Map<string, LiveStream>;
    try {
      streams = await fetchLiveStreams(sources.map((s) => str(s.config.userId)).filter(Boolean));
    } catch (error) {
      // Without live status nobody can be judged offline, so skip the whole pass.
      log.error("[social] twitch live status check failed:", error);
      return;
    }
    const guildEnabled = new Map<string, boolean>();
    const send = discordSender(client);
    for (const source of sources) {
      const all = await listEnabledSubscriptionsForSource(source.id);
      const subscriptions: FeedSubscriptionRow[] = [];
      for (const subscription of all) {
        if (!guildEnabled.has(subscription.guildId)) {
          const config = await configManager.getEffectiveConfig(subscription.guildId).catch(() => null);
          guildEnabled.set(subscription.guildId, config ? pluginEnabled(config, "social") : false);
        }
        if (guildEnabled.get(subscription.guildId)) subscriptions.push(subscription);
      }
      try {
        await handleTwitchSource(client, source, streams.get(str(source.config.userId)), subscriptions, send);
      } catch (error) {
        log.error(`[social] twitch source ${source.id} failed:`, error);
      }
    }
  } finally {
    running = false;
  }
}
