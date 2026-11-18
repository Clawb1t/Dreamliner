/**
 * Feed operations shared by the dashboard bridge and /notifications: pause/resume, test sends and
 * the sample item a preview or test uses. Every function takes the guild id and only touches that
 * server's subscriptions.
 */
import type { Client } from "discord.js";
import { fetchLiveStream } from "../functions/twitch.js";
import { buildFeedPayload } from "./render.js";
import { sendToChannel } from "./deliver.js";
import { refreshSource } from "./poller.js";
import { streamToItem } from "./twitch.js";
import {
  getSource,
  getSubscription,
  latestItems,
  listEnabledSubscriptionsForSource,
  maxItemId,
  openTwitchSession,
  reactivateSource,
  updateDeliveryPayload,
  updateSubscription,
  upsertItem,
  type FeedItemRow,
  type FeedSourceRow,
  type FeedSubscriptionRow,
} from "./store.js";

/**
 * Pause or resume a feed. Resuming starts from what the source has now, so whatever was posted
 * while it was paused isn't announced late; a disabled (failing) source gets another chance.
 */
export async function setFeedEnabled(guildId: string, id: number, enabled: boolean): Promise<FeedSubscriptionRow | null> {
  const existing = await getSubscription(guildId, id);
  if (!existing) return null;
  if (!enabled || existing.enabled) return updateSubscription(guildId, id, { enabled });

  const source = await getSource(existing.sourceId);
  if (source) {
    await reactivateSource(source.id);
    const othersActive = (await listEnabledSubscriptionsForSource(source.id)).some((s) => s.id !== id);
    if (source.type === "twitch") {
      // A stream already running is skipped; a session left open while paused is closed quietly.
      const stream = await fetchLiveStream(String(source.config.userId)).catch(() => null);
      if (stream) await upsertItem(source.id, streamToItem(stream), false);
      const open = openTwitchSession(id);
      if (open) await updateDeliveryPayload(open.id, { ...open.payload, endedAt: Date.now() });
    } else if (!othersActive) {
      // Nobody else kept this source polled: catch up now so the backlog lands behind the cursor.
      const fresh = await getSource(source.id);
      if (fresh) await refreshSource(fresh).catch(() => undefined);
    }
  }
  return updateSubscription(guildId, id, { enabled: true, cursorItemId: source ? maxItemId(source.id) : existing.cursorItemId });
}

/** The newest real item of a source (fetching once if it has none yet), or a sample. */
export async function sampleItemFor(source: FeedSourceRow): Promise<FeedItemRow> {
  if (source.type === "twitch") {
    const stream = await fetchLiveStream(String(source.config.userId)).catch(() => null);
    if (stream) {
      const item = streamToItem(stream);
      return { id: 0, sourceId: source.id, itemKey: item.key, title: item.title, url: item.url, imageUrl: item.imageUrl, summary: "", author: null, tags: item.tags, publishedAt: item.publishedAt, firstSeenAt: new Date(), baseline: false, payload: item.payload ?? {} };
    }
  }
  let latest = latestItems(source.id, 1)[0];
  if (!latest && source.type !== "twitch") {
    await refreshSource(source).catch(() => undefined);
    latest = latestItems(source.id, 1)[0];
  }
  if (latest) return latest;
  return {
    id: 0,
    sourceId: source.id,
    itemKey: "sample",
    title: source.type === "twitch" ? `${source.title} sample stream` : `${source.title} sample post`,
    url: source.siteUrl ?? "https://dreamliner.site/",
    imageUrl: source.iconUrl,
    summary: "This is a test post. Real posts show the item's excerpt here.",
    author: null,
    tags: [],
    publishedAt: new Date(),
    firstSeenAt: new Date(),
    baseline: false,
    payload: source.type === "twitch" ? { gameName: "Just Chatting", viewerCount: 0, startedAt: Date.now() } : { kind: "video", typeLabel: "video" },
  };
}

export type TestSendResult = { ok: true; messageId: string; channelId: string } | { ok: false; error: string; status: number };

/** Post the feed's message for its newest item, without recording a delivery. */
export async function testSendFeed(client: Client, guildId: string, id: number): Promise<TestSendResult> {
  const subscription = await getSubscription(guildId, id);
  if (!subscription) return { ok: false, error: "No feed with that ID.", status: 404 };
  const source = await getSource(subscription.sourceId);
  if (!source) return { ok: false, error: "This feed's source is missing.", status: 404 };
  const item = await sampleItemFor(source);
  const payload = buildFeedPayload(subscription.message, source, item, { roleIds: subscription.mentionRoleIds, silent: true });
  const message = await sendToChannel(client, guildId, subscription.channelId, payload);
  if (!message) return { ok: false, error: "Couldn't send to that channel. Check the bot's permissions there.", status: 502 };
  return { ok: true, messageId: message.id, channelId: message.channelId };
}
