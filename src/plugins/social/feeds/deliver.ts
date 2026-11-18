/**
 * Delivery: for each subscription, its pending items (oldest first, at most MAX_SENDS_PER_TICK per
 * tick) are filtered, reserved, sent, and only then marked delivered. The reservation is the
 * unique (subscription_id, item_id) row, so two ticks (or two processes) can never post the same
 * item twice; a send that fails is retried on a later tick, up to MAX_DELIVERY_ATTEMPTS.
 */
import { MessageFlags, type Client, type Message } from "discord.js";
import { fetchGuildChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import type { YoutubeUploadKind } from "../../../config/schemas/social.js";
import { inQuietHours, resolveTypeMessage, withinCooldown } from "../functions/logic.js";
import { filterReason } from "./filters.js";
import { buildFeedPayload, type FeedPayload, type FeedSendOptions } from "./render.js";
import {
  completeDelivery,
  failDelivery,
  latestPostedDelivery,
  pendingItemsFor,
  recordFiltered,
  reserveDelivery,
  type FeedItemRow,
  type FeedSourceRow,
  type FeedSubscriptionRow,
} from "./store.js";
const log = getLogger("social");

export const MAX_SENDS_PER_TICK = 3;

export type SendResult = { messageId: string; channelId: string } | { error: string };
export type Sender = (subscription: FeedSubscriptionRow, payload: FeedPayload) => Promise<SendResult>;

/** Send into a subscription's channel, only ever inside its own server. Never throws. */
export async function sendToChannel(client: Client, guildId: string, channelId: string, payload: FeedPayload): Promise<Message | null> {
  try {
    const channel = await fetchGuildChannel(client, guildId, channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    return await channel.send(payload as Parameters<typeof channel.send>[0]);
  } catch (error) {
    log.warn(`[social] couldn't post in ${channelId} (guild ${guildId}):`, error);
    return null;
  }
}

export function discordSender(client: Client): Sender {
  return async (subscription, payload) => {
    const channel = await fetchGuildChannel(client, subscription.guildId, subscription.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return { error: "The channel is missing or the bot can't post there." };
    try {
      const message = await channel.send(payload as Parameters<typeof channel.send>[0]);
      return { messageId: message.id, channelId: message.channelId };
    } catch (error) {
      const text = (error as { message?: string }).message ?? "Send failed";
      return { error: text.slice(0, 200) };
    }
  };
}

/** Edit a message the bot posted. Never throws; false when it's gone or not editable. */
export async function editFeedMessage(client: Client, guildId: string, channelId: string, messageId: string, payload: FeedPayload): Promise<boolean> {
  try {
    const channel = await fetchGuildChannel(client, guildId, channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return false;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message || !message.editable) return false;
    const { flags, ...rest } = payload;
    // Edits never re-ping, and only the Components V2 flag carries over (silent is send-only).
    const v2 = Boolean((flags ?? 0) & MessageFlags.IsComponentsV2);
    await message.edit({ ...rest, ...(v2 ? { flags: MessageFlags.IsComponentsV2 } : {}), allowedMentions: { parse: [] } } as Parameters<typeof message.edit>[0]);
    return true;
  } catch (error) {
    log.warn(`[social] couldn't edit message ${messageId}:`, error);
    return false;
  }
}

export async function deleteFeedMessage(client: Client, guildId: string, channelId: string, messageId: string): Promise<boolean> {
  try {
    const channel = await fetchGuildChannel(client, guildId, channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return false;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return false;
    await message.delete();
    return true;
  } catch (error) {
    log.warn(`[social] couldn't delete message ${messageId}:`, error);
    return false;
  }
}

/** A follow-up in the channel, replying to `replyTo` when it still exists. */
export async function sendFollowUp(client: Client, guildId: string, channelId: string, payload: FeedPayload, replyTo?: string | null): Promise<Message | null> {
  return sendToChannel(client, guildId, channelId, {
    ...payload,
    allowedMentions: { parse: [] },
    ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
  } as FeedPayload);
}

/** Roles, quiet hours and cooldown for one post. */
export function sendOptionsFor(
  subscription: Pick<FeedSubscriptionRow, "message" | "mentionRoleIds" | "options">,
  source: Pick<FeedSourceRow, "type">,
  item: Pick<FeedItemRow, "payload">,
  lastPostedAt: Date | null,
  now: Date = new Date(),
): FeedSendOptions {
  let roleIds = subscription.mentionRoleIds;
  let contentOverride: string | undefined;
  if (source.type === "youtube") {
    const kind = (typeof item.payload.kind === "string" ? item.payload.kind : "video") as YoutubeUploadKind;
    const typed = resolveTypeMessage(subscription.options, kind, { messageContent: subscription.message.content, mentionRoleIds: roleIds });
    roleIds = typed.mentionRoleIds;
    if (typed.messageContent !== subscription.message.content) contentOverride = typed.messageContent;
  }
  const silent =
    inQuietHours(subscription.options, now) ||
    (subscription.options.cooldown_minutes > 0 && withinCooldown(lastPostedAt, subscription.options.cooldown_minutes, now));
  return { roleIds, silent, contentOverride };
}

export type DeliverOutcome = "sent" | "filtered" | "skipped" | "failed";

/** Filter, reserve, send, then mark one item for one subscription. */
export async function deliverItem(
  subscription: FeedSubscriptionRow,
  source: FeedSourceRow,
  item: FeedItemRow,
  send: Sender,
  now: Date = new Date(),
): Promise<DeliverOutcome> {
  const reason = filterReason(subscription.filters, source.type, item);
  if (reason) {
    recordFiltered(subscription, item.id, reason);
    return "filtered";
  }
  const deliveryId = reserveDelivery(subscription, item.id, now);
  if (deliveryId === null) return "skipped";
  try {
    const last = await latestPostedDelivery(subscription.id).catch(() => null);
    const options = sendOptionsFor(subscription, source, item, last?.createdAt ?? null, now);
    const payload = buildFeedPayload(subscription.message, source, item, options);
    const result = await send(subscription, payload);
    if ("error" in result) {
      failDelivery(deliveryId, result.error);
      return "failed";
    }
    completeDelivery(deliveryId, result.messageId, result.channelId, { kind: item.payload.kind ?? null, silent: Boolean(options.silent) });
    return "sent";
  } catch (error) {
    failDelivery(deliveryId, (error as Error)?.message ?? "Send failed");
    log.error(`[social] feed ${subscription.id}: delivering item ${item.id} failed:`, error);
    return "failed";
  }
}

/** Work through one subscription's pending items, oldest first, sending at most `maxSends`. */
export async function deliverPending(
  subscription: FeedSubscriptionRow,
  source: FeedSourceRow,
  send: Sender,
  maxSends = MAX_SENDS_PER_TICK,
  now: Date = new Date(),
): Promise<{ sent: number; filtered: number; failed: number }> {
  const counts = { sent: 0, filtered: 0, failed: 0 };
  // Filtered items don't use up the send budget, so look a little further ahead.
  const items = pendingItemsFor(subscription, maxSends * 5, now);
  for (const item of items) {
    if (counts.sent + counts.failed >= maxSends) break;
    const outcome = await deliverItem(subscription, source, item, send, now);
    if (outcome === "sent") counts.sent += 1;
    else if (outcome === "filtered") counts.filtered += 1;
    else if (outcome === "failed") {
      counts.failed += 1;
      // The channel is probably broken: don't burn every pending item's attempts this tick.
      break;
    }
  }
  return counts;
}
