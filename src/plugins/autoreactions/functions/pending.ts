type PendingAutoreactionAdd = {
  emoji: string;
  expiresAt: number;
};

const pending = new Map<string, PendingAutoreactionAdd>();
const TTL_MS = 15 * 60_000;

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function prune(): void {
  const now = Date.now();
  for (const [k, value] of pending) {
    if (value.expiresAt <= now) pending.delete(k);
  }
}

export function setPendingAutoreactionEmoji(guildId: string, userId: string, emoji: string): void {
  prune();
  pending.set(key(guildId, userId), { emoji, expiresAt: Date.now() + TTL_MS });
}

export function takePendingAutoreactionEmoji(guildId: string, userId: string): string | null {
  prune();
  const entry = pending.get(key(guildId, userId));
  if (!entry) return null;
  pending.delete(key(guildId, userId));
  if (entry.expiresAt <= Date.now()) return null;
  return entry.emoji;
}
