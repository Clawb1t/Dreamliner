import { DiscordAPIError, PermissionFlagsBits, type Channel, type Webhook } from "discord.js";
import { capMap } from "./mapPrune.js";

/**
 * Shared helper for the bot's own named webhooks (one per channel per feature). Threads resolve to
 * their parent channel, since webhooks live on the parent and post into a thread with `threadId`.
 * Webhooks are cached per channel for 10 minutes; callers drop an entry with
 * `invalidateOwnedWebhook` when Discord says the webhook is gone (Unknown Webhook, 10015).
 *
 * Plugins with their own older copy of this (persist, translation, counting, expand) still use
 * theirs; new code should use this one.
 */

const CACHE_MS = 10 * 60_000;
const MAX_CACHE = 5000;
const MAX_OWN_IDS = 20_000;

type WebhookChannel = {
  id: string;
  guild: { members: { me: { id: string } | null } };
  fetchWebhooks: () => Promise<Map<string, Webhook> & { find: (fn: (hook: Webhook) => boolean) => Webhook | undefined }>;
  createWebhook: (options: { name: string; reason?: string }) => Promise<Webhook>;
  permissionsFor: (member: { id: string }) => { has: (bit: bigint) => boolean } | null;
};

export type OwnedWebhook = {
  webhook: Webhook;
  /** Set when the target was a thread: pass it as `threadId` when sending or editing. */
  threadId?: string;
  /** The channel the webhook belongs to (the thread's parent for threads). */
  channelId: string;
};

const cache = new Map<string, { webhook: Webhook; at: number }>();

/** Ids of webhooks this bot created/uses, so plugins can recognise their own webhook messages. */
export const ownWebhookIds = new Set<string>();

export function rememberOwnWebhook(id: string): void {
  ownWebhookIds.delete(id);
  ownWebhookIds.add(id);
  if (ownWebhookIds.size > MAX_OWN_IDS) {
    let excess = ownWebhookIds.size - Math.floor(MAX_OWN_IDS * 0.9);
    for (const key of ownWebhookIds) {
      if (excess-- <= 0) break;
      ownWebhookIds.delete(key);
    }
  }
}

export function isOwnWebhookId(id: string | null | undefined): boolean {
  return Boolean(id && ownWebhookIds.has(id));
}

/** The channel a webhook for `channel` lives on, plus the thread id when `channel` is a thread. */
export function webhookTarget(channel: Channel): { parent: WebhookChannel; threadId?: string } | null {
  if (channel.isDMBased()) return null;
  if (channel.isThread()) {
    const parent = channel.parent as unknown as WebhookChannel | null;
    if (!parent || typeof parent.fetchWebhooks !== "function" || typeof parent.createWebhook !== "function") return null;
    return { parent, threadId: channel.id };
  }
  const candidate = channel as unknown as WebhookChannel;
  if (typeof candidate.fetchWebhooks !== "function" || typeof candidate.createWebhook !== "function") return null;
  return { parent: candidate };
}

/** Whether the bot has Manage Webhooks where a webhook for `channel` would live. */
export function canManageWebhooks(channel: Channel): boolean {
  const target = webhookTarget(channel);
  const me = target?.parent.guild.members.me;
  if (!target || !me) return false;
  return Boolean(target.parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks));
}

function cacheKey(channelId: string, name: string): string {
  return `${channelId}:${name}`;
}

export function invalidateOwnedWebhook(channelId: string, name: string): void {
  cache.delete(cacheKey(channelId, name));
}

export function isUnknownWebhookError(error: unknown): boolean {
  return error instanceof DiscordAPIError ? error.code === 10015 : (error as { code?: unknown })?.code === 10015;
}

/**
 * The bot's webhook called `name` for `channel` (a thread resolves to its parent), created when
 * missing unless `create: false`. Null without Manage Webhooks or when Discord refuses.
 */
export async function getOwnedWebhook(
  channel: Channel,
  name: string,
  reason: string,
  options: { create?: boolean } = {},
): Promise<OwnedWebhook | null> {
  const target = webhookTarget(channel);
  if (!target) return null;
  const { parent, threadId } = target;
  const me = parent.guild.members.me;
  if (!me || !parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) return null;

  const key = cacheKey(parent.id, name);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { webhook: hit.webhook, threadId, channelId: parent.id };

  try {
    const existing = await parent.fetchWebhooks();
    let webhook = existing.find((hook) => hook.owner?.id === me.id && hook.name === name && Boolean(hook.token)) ?? null;
    if (!webhook && options.create !== false) webhook = await parent.createWebhook({ name, reason });
    if (!webhook) return null;
    rememberOwnWebhook(webhook.id);
    cache.delete(key);
    cache.set(key, { webhook, at: Date.now() });
    capMap(cache, MAX_CACHE);
    return { webhook, threadId, channelId: parent.id };
  } catch {
    return null;
  }
}
