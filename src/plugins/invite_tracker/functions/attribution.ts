import type { JoinSource } from "./config.js";

/** One invite as the cache keeps it: plain primitives only, so thousands of them stay small. */
export type CachedInvite = {
  uses: number;
  /** 0 = unlimited */
  maxUses: number;
  inviterId: string | null;
  /** Epoch ms, null = never expires. */
  expiresAt: number | null;
  channelId: string | null;
};

/** A guild's invites at one moment. */
export type InviteSnapshot = {
  invites: Map<string, CachedInvite>;
  /** null when the guild has no vanity URL (or it couldn't be read). */
  vanityUses: number | null;
  /** False when the bot lacks Manage Server, so the invite list couldn't be read at all. */
  permOk: boolean;
};

export type Attribution = {
  source: JoinSource;
  code: string | null;
  inviterId: string | null;
  channelId: string | null;
};

export const UNKNOWN_ATTRIBUTION: Attribution = { source: "unknown", code: null, inviterId: null, channelId: null };

/**
 * Works out which invite a join used by diffing the invite list from before the join against a
 * fresh one, in order:
 * 1. A bot joining is `oauth` (bots are added through the OAuth flow, never an invite).
 * 2. Exactly one code whose uses went up is the one used. More than one is `unknown`.
 * 3. Otherwise a single code that vanished counts, if it ran out of uses or hadn't expired yet
 *    (a single-use invite is deleted the moment it's used; an expired one just timed out).
 * 4. Otherwise the vanity URL, if its uses went up.
 * Without both snapshots (cold cache, missing Manage Server) it's always `unknown`. A code that
 * belongs to a tracked link is `tracked`, and credits no one (the bot created the invite).
 */
export function attributeJoin(input: {
  before: InviteSnapshot | null;
  after: InviteSnapshot | null;
  isBot: boolean;
  trackedCodes?: ReadonlySet<string>;
  now?: number;
}): Attribution {
  if (input.isBot) return { ...UNKNOWN_ATTRIBUTION, source: "oauth" };
  const { before, after } = input;
  if (!before || !after || !before.permOk || !after.permOk) return UNKNOWN_ATTRIBUTION;
  const now = input.now ?? Date.now();

  let used: [string, CachedInvite] | null = null;
  const increased: Array<[string, CachedInvite]> = [];
  for (const [code, invite] of after.invites) {
    const previous = before.invites.get(code)?.uses ?? 0;
    if (invite.uses > previous) increased.push([code, invite]);
  }
  if (increased.length > 1) return UNKNOWN_ATTRIBUTION;
  if (increased.length === 1) used = increased[0]!;

  if (!used) {
    const vanished: Array<[string, CachedInvite]> = [];
    for (const [code, invite] of before.invites) {
      if (after.invites.has(code)) continue;
      const usedUp = invite.maxUses > 0 && invite.uses + 1 >= invite.maxUses;
      const notExpired = invite.expiresAt === null || invite.expiresAt > now;
      if (usedUp || notExpired) vanished.push([code, invite]);
    }
    if (vanished.length > 1) return UNKNOWN_ATTRIBUTION;
    if (vanished.length === 1) used = vanished[0]!;
  }

  if (!used) {
    if (before.vanityUses !== null && after.vanityUses !== null && after.vanityUses > before.vanityUses) {
      return { ...UNKNOWN_ATTRIBUTION, source: "vanity" };
    }
    return UNKNOWN_ATTRIBUTION;
  }

  const [code, invite] = used;
  if (input.trackedCodes?.has(code)) {
    return { source: "tracked", code, inviterId: null, channelId: invite.channelId };
  }
  return { source: "invite", code, inviterId: invite.inviterId, channelId: invite.channelId };
}
