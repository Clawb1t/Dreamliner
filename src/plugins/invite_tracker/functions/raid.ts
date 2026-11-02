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
