/**
 * The feeds poller. Every 30 seconds one tick:
 *  1. picks the sources that are due (`next_check_at`), at most MAX_SOURCES_PER_TICK, and fetches
 *     them FETCH_CONCURRENCY at a time. Each unique upstream is fetched once, however many
 *     servers follow it. Success schedules the next check at the source's interval with jitter;
 *     failure backs off exponentially (or as long as a 429's Retry-After asks), and a source that
 *     fails MAX_FAILURES checks in a row is disabled with the reason shown on the dashboard;
 *  2. delivers: every subscription with pending items gets at most 3 posts (see deliver.ts).
 * A tick that's still running when the next one is due is skipped (overlap guard). Twitch has its
 * own 2 minute batched path (twitch.ts).
 */
import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { mapWithConcurrency } from "../../../core/concurrency.js";
import { getLogger } from "../../../core/logger.js";
import { adapterFor } from "./adapters/index.js";
import { deliverPending, discordSender, type Sender } from "./deliver.js";
import { FeedError, type FeedAdapter, type FeedItemInput } from "./types.js";
import {
  getSourcesByIds,
  getSubscriptionById,
  insertItems,
  knownItemKeys,
  listDueSources,
  pendingItemsFor,
  recordFiltered,
  subscriptionsWithPendingItems,
  updateSource,
  type FeedItemRow,
  type FeedSourceRow,
} from "./store.js";
const log = getLogger("social");

export const POLL_TICK_MS = 30_000;
export const MAX_SOURCES_PER_TICK = 25;
export const FETCH_CONCURRENCY = 4;
export const MAX_FAILURES = 10;
export const MAX_BACKOFF_S = 6 * 3600;
export const MIN_INTERVAL_S = 60;

/** interval ± 10%, so sources added together don't stay in lockstep. */
export function jittered(intervalS: number, random: () => number = Math.random): number {
  const base = Math.max(MIN_INTERVAL_S, intervalS);
  return Math.round(base * (0.9 + random() * 0.2));
}

/** Seconds until the next try after `failCount` failures in a row. */
export function backoffSeconds(intervalS: number, failCount: number, retryAfterS: number | null): number {
  const exp = Math.min(MAX_BACKOFF_S, Math.max(MIN_INTERVAL_S, intervalS) * 2 ** Math.min(failCount, 8));
  return Math.min(MAX_BACKOFF_S, Math.max(exp, retryAfterS ?? 0));
}

export type RefreshResult = { ok: true; inserted: FeedItemRow[]; notModified: boolean } | { ok: false; error: string; disabled: boolean };

/** Dedupe a batch on its keys (feeds sometimes repeat an entry). */
function uniqueByKey(items: FeedItemInput[]): FeedItemInput[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.key || seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

/**
 * Fetch one source and store its new items. The first successful fetch of a source stores what's
 * there as baseline (never posted); migrated sources carry a watermark so uploads published after
 * their old checkpoint still post.
 */
export async function refreshSource(
  source: FeedSourceRow,
  now: Date = new Date(),
  adapter: FeedAdapter | null = adapterFor(source),
): Promise<RefreshResult> {
  if (!adapter) return { ok: false, error: "This source type isn't polled here.", disabled: false };
  try {
    const result = await adapter.fetch(source);
    const nextCheckAt = new Date(now.getTime() + jittered(source.intervalS) * 1000);
    if (result.notModified) {
      await updateSource(source.id, { lastCheckedAt: now, lastOkAt: now, nextCheckAt, failCount: 0, lastError: null });
      return { ok: true, inserted: [], notModified: true };
    }
    let inserted: FeedItemRow[] = [];
    const unchanged = Boolean(result.contentHash && result.contentHash === source.contentHash && source.lastOkAt);
    if (!unchanged) {
      const items = uniqueByKey(result.items);
      const known = knownItemKeys(source.id, items.map((i) => i.key));
      let fresh = items.filter((item) => !known.has(item.key));
      if (fresh.length && adapter.enrich) fresh = await adapter.enrich(source, fresh);
      const firstFetch = source.lastOkAt === null;
      const watermark = typeof source.state.baselineBefore === "number" ? source.state.baselineBefore : null;
      const baseline: boolean | ((item: FeedItemInput) => boolean) = !firstFetch
        ? false
        : watermark === null
          ? true
          : (item) => !item.publishedAt || item.publishedAt.getTime() <= watermark;
      inserted = await insertItems(source.id, fresh, baseline, now);
    }
    const { baselineBefore: _done, ...state } = source.state;
    await updateSource(source.id, {
      lastCheckedAt: now,
      lastOkAt: now,
      nextCheckAt,
      failCount: 0,
      lastError: null,
      etag: result.etag ?? null,
      lastModified: result.lastModified ?? null,
      contentHash: result.contentHash ?? null,
      ...(source.title ? {} : result.title ? { title: result.title } : {}),
      ...(source.iconUrl ? {} : result.iconUrl ? { iconUrl: result.iconUrl } : {}),
      ...(source.siteUrl ? {} : result.siteUrl ? { siteUrl: result.siteUrl } : {}),
      ...(_done !== undefined ? { state } : {}),
    });
    return { ok: true, inserted: inserted.filter((item) => !item.baseline), notModified: false };
  } catch (error) {
    const feedError = error instanceof FeedError ? error : new FeedError((error as Error)?.message ?? "The source couldn't be fetched.");
    const failCount = source.failCount + (feedError.permanent ? 2 : 1);
    const disabled = failCount >= MAX_FAILURES;
    await updateSource(source.id, {
      lastCheckedAt: now,
      failCount,
      lastError: feedError.message.slice(0, 300),
      nextCheckAt: new Date(now.getTime() + backoffSeconds(source.intervalS, failCount, feedError.retryAfterS) * 1000),
      ...(disabled ? { disabledReason: `Paused after ${failCount} failed checks in a row: ${feedError.message.slice(0, 200)}` } : {}),
    });
    if (!(error instanceof FeedError)) log.warn(`[social] source ${source.id} (${source.key}) failed:`, error);
    return { ok: false, error: feedError.message, disabled };
  }
}

/** Deliver pending items for every subscription that has some. */
export async function deliverAllPending(send: Sender, now: Date = new Date()): Promise<{ sent: number; filtered: number; failed: number }> {
  const totals = { sent: 0, filtered: 0, failed: 0 };
  const ids = subscriptionsWithPendingItems(now);
  if (!ids.length) return totals;
  const guildEnabled = new Map<string, boolean>();
  const subscriptions = (await Promise.all(ids.map((id) => getSubscriptionById(id)))).filter((s) => s !== null);
  const sources = await getSourcesByIds(subscriptions.map((s) => s.sourceId));
  await mapWithConcurrency(subscriptions, 4, async (subscription) => {
    const source = sources.get(subscription.sourceId);
    if (!source) return;
    if (!guildEnabled.has(subscription.guildId)) {
      const config = await configManager.getEffectiveConfig(subscription.guildId).catch(() => null);
      guildEnabled.set(subscription.guildId, config ? pluginEnabled(config, "social") : false);
    }
    if (!guildEnabled.get(subscription.guildId)) {
      // The plugin is off in this server: skip what came in, so turning it on doesn't post a backlog.
      for (const item of pendingItemsFor(subscription, 50, now)) recordFiltered(subscription, item.id, "Notifications plugin was off");
      return;
    }
    try {
      const counts = await deliverPending(subscription, source, send, undefined, now);
      totals.sent += counts.sent;
      totals.filtered += counts.filtered;
      totals.failed += counts.failed;
    } catch (error) {
      log.error(`[social] delivery failed for feed ${subscription.id} (guild ${subscription.guildId}):`, error);
    }
  });
  return totals;
}

let running = false;

/** One poller tick (fetch due sources, then deliver). Overlapping ticks are skipped. */
export async function pollFeedsTick(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const due = listDueSources(now, MAX_SOURCES_PER_TICK);
    if (due.length) await mapWithConcurrency(due, FETCH_CONCURRENCY, (source) => refreshSource(source, now));
    await deliverAllPending(discordSender(client));
  } finally {
    running = false;
  }
}
