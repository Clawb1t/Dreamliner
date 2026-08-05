export type Slot = {
  guildId: string;
  channelId: string;
  userId: string;
  /** Last allowed message — slowmode emoji goes here after a violation. */
  messageId: string;
  allowedCreatedAt: number;
  /** When the user may send again (anchor created time + delay). */
  availableAt: number;
  delaySeconds: number;
};

const slots = new Map<string, Slot>();

export function cooldownKey(guildId: string, channelId: string, userId: string): string {
  return `${guildId}:${channelId}:${userId}`;
}

/** Returns the slot only if the slowmode window is still active; drops expired entries. */
export function getActiveSlot(key: string, now = Date.now()): Slot | null {
  const slot = slots.get(key);
  if (!slot) return null;
  if (now >= slot.availableAt) {
    slots.delete(key);
    return null;
  }
  return slot;
}

export function setAnchorSlot(
  guildId: string,
  channelId: string,
  userId: string,
  messageId: string,
  allowedCreatedAt: number,
  delaySeconds: number,
): Slot {
  const key = cooldownKey(guildId, channelId, userId);
  const availableAt = allowedCreatedAt + delaySeconds * 1000;
  const slot: Slot = {
    guildId,
    channelId,
    userId,
    messageId,
    allowedCreatedAt,
    availableAt,
    delaySeconds,
  };
  slots.set(key, slot);
  return slot;
}

export function clearSlot(key: string): Slot | null {
  const slot = slots.get(key) ?? null;
  slots.delete(key);
  return slot;
}

export function sweepExpiredSlots(now = Date.now()): Slot[] {
  const expired: Slot[] = [];
  for (const [key, slot] of slots) {
    if (now >= slot.availableAt) {
      slots.delete(key);
      expired.push(slot);
    }
  }
  return expired;
}
