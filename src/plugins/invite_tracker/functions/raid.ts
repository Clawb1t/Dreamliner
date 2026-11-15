/** Discord pauses invites for at most 24 hours at a time. */
export const MAX_PAUSE_MINUTES = 24 * 60;
export const MIN_PAUSE_MINUTES = 15;
/** After a burst triggers, the same guild can't trigger again for this long. */
export const RAID_COOLDOWN_MS = 10 * 60_000;

export function clampPauseMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 60;
  return Math.min(MAX_PAUSE_MINUTES, Math.max(MIN_PAUSE_MINUTES, Math.round(minutes)));
}

/**
 * Sliding-window join-burst detection. Each guild keeps a small ring of recent join timestamps
 * per invite key (the code, or the source for vanity/unknown joins), capped at the threshold, so
 * memory stays tiny no matter how many people join.
 */
export class RaidDetector {
  private readonly guilds = new Map<string, { keys: Map<string, number[]>; cooldownUntil: number }>();

  /** Records one join and returns true when it crosses the threshold (and isn't on cooldown). */
  record(guildId: string, key: string, now: number, options: { threshold: number; windowSeconds: number }): boolean {
    const threshold = Math.max(1, Math.floor(options.threshold));
    const windowMs = options.windowSeconds * 1000;
    let guild = this.guilds.get(guildId);
    if (!guild) {
      guild = { keys: new Map(), cooldownUntil: 0 };
      this.guilds.set(guildId, guild);
    }
    const ring = guild.keys.get(key) ?? [];
    ring.push(now);
    while (ring.length > threshold) ring.shift();
    while (ring.length > 0 && now - ring[0]! > windowMs) ring.shift();
    guild.keys.set(key, ring);

    // Drop other keys that have gone quiet, so a long-lived guild doesn't accumulate codes.
    for (const [other, times] of guild.keys) {
      if (other !== key && (times.length === 0 || now - times[times.length - 1]! > windowMs)) guild.keys.delete(other);
    }

    if (ring.length < threshold || now < guild.cooldownUntil) return false;
    guild.cooldownUntil = now + RAID_COOLDOWN_MS;
    guild.keys.delete(key);
    return true;
  }

  forget(guildId: string): void {
    this.guilds.delete(guildId);
  }

  get size(): number {
    return this.guilds.size;
  }
}

export type RaidJoiner = { id: string; username: string; joinedAt: number };

/** How many of a burst's accounts are kept for the Raid Defense Mesh alert (it shares at most 15). */
export const MAX_RAID_JOINERS = 15;

/**
 * The most recent joiners per invite key, so a tripped burst can name the accounts involved
 * (for Raid Defense Mesh). Capped per key and pruned to the burst window, so it stays tiny.
 */
export class RecentRaidJoiners {
  private readonly lists = new Map<string, RaidJoiner[]>();

  record(guildId: string, key: string, joiner: RaidJoiner, windowSeconds: number): void {
    const mapKey = `${guildId}:${key}`;
    const cutoff = joiner.joinedAt - windowSeconds * 1000;
    const list = (this.lists.get(mapKey) ?? []).filter((j) => j.joinedAt >= cutoff && j.id !== joiner.id);
    list.push(joiner);
    while (list.length > MAX_RAID_JOINERS) list.shift();
    this.lists.set(mapKey, list);
    // Drop this guild's other keys once they've gone quiet.
    for (const [other, items] of this.lists) {
      if (other !== mapKey && other.startsWith(`${guildId}:`) && (items.at(-1)?.joinedAt ?? 0) < cutoff) this.lists.delete(other);
    }
  }

  /** The joiners for a key, newest first, and forgets them. */
  take(guildId: string, key: string): RaidJoiner[] {
    const mapKey = `${guildId}:${key}`;
    const list = this.lists.get(mapKey) ?? [];
    this.lists.delete(mapKey);
    return [...list].reverse();
  }

  forget(guildId: string): void {
    for (const key of this.lists.keys()) if (key.startsWith(`${guildId}:`)) this.lists.delete(key);
  }
}
