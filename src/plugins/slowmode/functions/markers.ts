import { Routes, type Client, type Snowflake } from "discord.js";
import { clearSlot, cooldownKey, getActiveSlot, sweepExpiredSlots, type Slot } from "./cooldown.js";

export const SLOWMODE_MARKER_EMOJI = "slowmode:1534690955217600683";

type MarkerState = {
  channelId: Snowflake;
  anchorMessageId: Snowflake;
  availableAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

const markers = new Map<string, MarkerState>();
let clientRef: Client | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function markerKey(guildId: string, channelId: string, userId: string): string {
  return cooldownKey(guildId, channelId, userId);
}

async function removeReaction(client: Client, channelId: string, messageId: string): Promise<void> {
  try {
    await client.rest.delete(
      Routes.channelMessageOwnReaction(channelId, messageId, SLOWMODE_MARKER_EMOJI),
    );
  } catch {
    // already gone
  }
}

function cancelMarker(key: string): MarkerState | null {
  const marker = markers.get(key);
  if (!marker) return null;
  clearTimeout(marker.timeout);
  markers.delete(key);
  return marker;
}

async function expireMarker(key: string, marker: MarkerState): Promise<void> {
  const current = markers.get(key);
  if (!current || current.anchorMessageId !== marker.anchorMessageId) return;

  cancelMarker(key);

  const slot = getActiveSlot(key);
  if (slot && slot.messageId === marker.anchorMessageId) {
    clearSlot(key);
  }

  const client = clientRef;
  if (client) await removeReaction(client, marker.channelId, marker.anchorMessageId);
}

function scheduleMarkerExpiry(key: string, marker: Omit<MarkerState, "timeout">): void {
  cancelMarker(key);

  const delay = Math.max(0, marker.availableAt - Date.now());
  const timeout = setTimeout(() => {
    void expireMarker(key, { ...marker, timeout });
  }, delay);

  markers.set(key, { ...marker, timeout });
}

async function sweepAll(): Promise<void> {
  const now = Date.now();
  for (const [key, marker] of [...markers.entries()]) {
    if (now < marker.availableAt) continue;
    await expireMarker(key, marker);
  }

  const client = clientRef;
  const expired = sweepExpiredSlots(now);
  if (!client) return;
  for (const slot of expired) {
    await removeReaction(client, slot.channelId, slot.messageId);
  }
}

export function startSlowmodeMarkerSweeper(client: Client): void {
  clientRef = client;
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepAll();
  }, 500);
}

export function stopSlowmodeMarkerSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  for (const [, marker] of markers) clearTimeout(marker.timeout);
  markers.clear();
  clientRef = null;
}

export async function clearMarkerForAnchor(
  client: Client,
  guildId: string,
  channelId: string,
  userId: string,
  anchorMessageId: string,
): Promise<void> {
  const key = markerKey(guildId, channelId, userId);
  const marker = markers.get(key);
  if (!marker || marker.anchorMessageId !== anchorMessageId) return;
  cancelMarker(key);
  await removeReaction(client, channelId, anchorMessageId);
}

/** Show slowmode emoji on the anchor after a violation; clears when `slot.availableAt` is reached. */
export async function ensureMarker(opts: {
  client: Client;
  guildId: string;
  channelId: string;
  userId: string;
  slot: Slot;
}): Promise<void> {
  const client = opts.client;
  clientRef = client;

  const key = markerKey(opts.guildId, opts.channelId, opts.userId);
  const active = getActiveSlot(key);
  if (!active || active.messageId !== opts.slot.messageId) return;

  const existing = markers.get(key);
  if (existing?.anchorMessageId === opts.slot.messageId) {
    scheduleMarkerExpiry(key, {
      channelId: opts.channelId,
      anchorMessageId: opts.slot.messageId,
      availableAt: opts.slot.availableAt,
    });
    return;
  }

  if (existing) {
    await removeReaction(client, existing.channelId, existing.anchorMessageId);
    cancelMarker(key);
  }

  try {
    await client.rest.put(
      Routes.channelMessageOwnReaction(opts.channelId, opts.slot.messageId, SLOWMODE_MARKER_EMOJI),
    );
    scheduleMarkerExpiry(key, {
      channelId: opts.channelId,
      anchorMessageId: opts.slot.messageId,
      availableAt: opts.slot.availableAt,
    });
  } catch (error) {
    console.error(
      `[slowmode] Failed to react on ${opts.slot.messageId} in ${opts.channelId}:`,
      error,
    );
  }
}
