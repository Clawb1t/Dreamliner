import type { Player } from "lavalink-client";
import { getLogger } from "../../../core/logger.js";
import { claimVoiceSession, releaseVoiceSession, type VoiceSessionOwner } from "../../../core/voiceSessionRegistry.js";
import { getLavalinkManager } from "./manager.js";

const log = getLogger("music");

const OWNER: VoiceSessionOwner = "music";

export type ClaimPlayerResult =
  | { ok: true; player: Player }
  | { ok: false; reason: "blocked_by_other"; ownedBy: VoiceSessionOwner }
  | { ok: false; reason: "connect_failed" };

/**
 * Gets the existing player for `guildId` if it's already connected to `voiceChannelId`, or claims
 * the shared voice registry and creates/connects a fresh one. Must be called before any playback
 * action — this is the one place music touches the voice registry (see voiceSessionRegistry.ts).
 */
export async function getOrConnectPlayer(
  guildId: string,
  voiceChannelId: string,
  textChannelId: string,
): Promise<ClaimPlayerResult> {
  const manager = getLavalinkManager();
  const existing = manager.getPlayer(guildId);
  if (existing && existing.voiceChannelId === voiceChannelId) {
    return { ok: true, player: existing };
  }

  const claim = claimVoiceSession(guildId, voiceChannelId, OWNER);
  if (!claim.ok) return { ok: false, reason: "blocked_by_other", ownedBy: claim.ownedBy };

  try {
    const player =
      existing ??
      manager.createPlayer({
        guildId,
        voiceChannelId,
        textChannelId,
        selfDeaf: true,
        selfMute: false,
      });

    if (existing && existing.voiceChannelId !== voiceChannelId) {
      // Moving to a different channel in the same guild — same owner, just relocating.
      await existing.changeVoiceState({ voiceChannelId, selfDeaf: true, selfMute: false });
      return { ok: true, player: existing };
    }

    await player.connect();
    return { ok: true, player };
  } catch (error) {
    log.error(`Failed to connect music player in guild ${guildId}:`, error);
    releaseVoiceSession(guildId, OWNER);
    return { ok: false, reason: "connect_failed" };
  }
}

export function getConnectedPlayer(guildId: string): Player | undefined {
  return getLavalinkManager().getPlayer(guildId);
}

/** Full teardown: stop, disconnect, and release the guild's voice claim. */
export async function destroyPlayer(guildId: string, reason: string): Promise<void> {
  const manager = getLavalinkManager();
  const player = manager.getPlayer(guildId);
  if (player) {
    try {
      await player.destroy(reason);
    } catch (error) {
      log.error(`Error destroying music player in guild ${guildId}:`, error);
    }
  }
  releaseVoiceSession(guildId, OWNER);
}
