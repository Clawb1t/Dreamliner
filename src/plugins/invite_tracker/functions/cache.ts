import { GuildFeature, PermissionFlagsBits, type Guild, type Invite } from "discord.js";
import { getLogger } from "../../../core/logger.js";
import type { CachedInvite, InviteSnapshot } from "./attribution.js";

const log = getLogger("invite_tracker");

/**
 * Each enabled guild's invite list as of the last join (or invite create/delete), kept as plain
 * primitives. Only guilds with the plugin on have an entry; it's dropped when the bot leaves the
 * guild or the plugin is turned off.
 */
type GuildInviteCache = InviteSnapshot & {
  vanityCode: string | null;
  /** Invites Discord reported deleted in the last few seconds. A single-use invite is deleted the
   *  moment it's used, and that event can land before the member's join, so the join still needs
   *  to see it in "before" to notice it vanished. */
  recentlyDeleted: Map<string, CachedInvite & { deletedAt: number }>;
  warmedAt: number;
};

const RECENTLY_DELETED_MS = 30_000;
const caches = new Map<string, GuildInviteCache>();

export function hasManageServer(guild: Guild): boolean {
  return Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild));
}

export function toCachedInvite(invite: Invite): CachedInvite {
  return {
    uses: invite.uses ?? 0,
    maxUses: invite.maxUses ?? 0,
    inviterId: invite.inviterId ?? invite.inviter?.id ?? null,
    expiresAt: invite.expiresTimestamp ?? null,
    channelId: invite.channelId ?? null,
  };
}

/** A fresh snapshot straight from Discord (never from discord.js's own invite cache). */
export async function fetchSnapshot(guild: Guild): Promise<InviteSnapshot & { vanityCode: string | null }> {
  if (!hasManageServer(guild)) return { invites: new Map(), vanityUses: null, vanityCode: null, permOk: false };
  const fetched = await guild.invites.fetch({ cache: false }).catch((error) => {
    log.warn(`Could not fetch invites in ${guild.id}: ${error instanceof Error ? error.message : error}`);
    return null;
  });
  if (!fetched) return { invites: new Map(), vanityUses: null, vanityCode: null, permOk: false };
  const invites = new Map<string, CachedInvite>();
  for (const invite of fetched.values()) invites.set(invite.code, toCachedInvite(invite));

  let vanityUses: number | null = null;
  let vanityCode: string | null = null;
  if (guild.features.includes(GuildFeature.VanityURL)) {
    const vanity = await guild.fetchVanityData().catch(() => null);
    if (vanity) {
      vanityUses = vanity.uses;
      vanityCode = vanity.code;
    }
  }
  return { invites, vanityUses, vanityCode, permOk: true };
}

export async function warmGuild(guild: Guild): Promise<void> {
  const snapshot = await fetchSnapshot(guild);
  caches.set(guild.id, { ...snapshot, recentlyDeleted: new Map(), warmedAt: Date.now() });
}

/** Replaces the cached list after a join diffed against it, keeping recent deletions. */
export function storeSnapshot(guildId: string, snapshot: InviteSnapshot & { vanityCode: string | null }): void {
  const previous = caches.get(guildId);
  caches.set(guildId, {
    ...snapshot,
    recentlyDeleted: previous?.recentlyDeleted ?? new Map(),
    warmedAt: Date.now(),
  });
}

/** The cached list as "before" for a join, including invites deleted moments ago. Null while cold. */
export function beforeSnapshot(guildId: string, now = Date.now()): InviteSnapshot | null {
  const cache = caches.get(guildId);
  if (!cache) return null;
  for (const [code, entry] of cache.recentlyDeleted) {
    if (now - entry.deletedAt > RECENTLY_DELETED_MS) cache.recentlyDeleted.delete(code);
  }
  if (cache.recentlyDeleted.size === 0) return cache;
  const invites = new Map(cache.invites);
  for (const [code, entry] of cache.recentlyDeleted) {
    if (!invites.has(code)) {
      const { deletedAt: _deletedAt, ...invite } = entry;
      invites.set(code, invite);
    }
  }
  return { invites, vanityUses: cache.vanityUses, permOk: cache.permOk };
}

export function onInviteCreated(guildId: string, invite: Invite): void {
  caches.get(guildId)?.invites.set(invite.code, toCachedInvite(invite));
}

export function onInviteDeleted(guildId: string, code: string): void {
  const cache = caches.get(guildId);
  if (!cache) return;
  const existing = cache.invites.get(code);
  cache.invites.delete(code);
  if (existing) cache.recentlyDeleted.set(code, { ...existing, deletedAt: Date.now() });
}

export function getCacheState(guildId: string): { warm: boolean; permOk: boolean; vanityCode: string | null; inviteCount: number } {
  const cache = caches.get(guildId);
  return {
    warm: Boolean(cache),
    permOk: cache?.permOk ?? false,
    vanityCode: cache?.vanityCode ?? null,
    inviteCount: cache?.invites.size ?? 0,
  };
}

export function isCached(guildId: string): boolean {
  return caches.has(guildId);
}

export function dropGuild(guildId: string): void {
  caches.delete(guildId);
}

export function cachedGuildIds(): string[] {
  return [...caches.keys()];
}

/** Codes currently cached for a guild, or null while it's cold or the list couldn't be read. */
export function cachedInviteCodes(guildId: string): Set<string> | null {
  const cache = caches.get(guildId);
  return cache?.permOk ? new Set(cache.invites.keys()) : null;
}
