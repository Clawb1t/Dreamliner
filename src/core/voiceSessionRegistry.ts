/**
 * Single source of truth for "which plugin currently owns the voice connection in this guild."
 *
 * @discordjs/voice's own connection tracking is a single process-wide map keyed only by guildId
 * (default group) — a second plugin calling joinVoiceChannel for the same guild but a different
 * channel doesn't fail or create a second connection, it silently moves/hijacks the existing one
 * and steals the other plugin's player subscription. lavalink-client sidesteps @discordjs/voice
 * entirely (it sends raw Gateway Voice State Updates itself), so it's equally invisible to that
 * map from the other direction. Every plugin that can join a voice channel (music, clipping, tts)
 * must claim a slot here BEFORE touching either transport, so all three arbitrate through one
 * chokepoint regardless of which transport they use underneath.
 */

export type VoiceSessionOwner = "music" | "clipping" | "tts";

type VoiceSession = {
  owner: VoiceSessionOwner;
  channelId: string;
  claimedAt: number;
};

const sessions = new Map<string, VoiceSession>();

export type ClaimResult = { ok: true } | { ok: false; ownedBy: VoiceSessionOwner; channelId: string };

/**
 * Claim the voice session for `guildId` on behalf of `owner`. The same owner re-claiming (same
 * or a different channel) always succeeds — that's just that plugin moving itself and is not a
 * conflict. Fails if a different owner currently holds the guild.
 */
export function claimVoiceSession(guildId: string, channelId: string, owner: VoiceSessionOwner): ClaimResult {
  const existing = sessions.get(guildId);
  if (existing && existing.owner !== owner) {
    return { ok: false, ownedBy: existing.owner, channelId: existing.channelId };
  }
  sessions.set(guildId, { owner, channelId, claimedAt: Date.now() });
  return { ok: true };
}

/** Release the claim on `guildId`, but only if `owner` is the one currently holding it. */
export function releaseVoiceSession(guildId: string, owner: VoiceSessionOwner): void {
  const existing = sessions.get(guildId);
  if (existing && existing.owner === owner) sessions.delete(guildId);
}

export function getVoiceSessionOwner(guildId: string): VoiceSessionOwner | null {
  return sessions.get(guildId)?.owner ?? null;
}

const OWNER_LABELS: Record<VoiceSessionOwner, string> = {
  music: "Music",
  clipping: "Clipping",
  tts: "Text-to-speech",
};

/** Friendly, owner-specific rejection line for whichever plugin got blocked. */
export function blockedByMessage(blockedOwner: VoiceSessionOwner, ownedBy: VoiceSessionOwner): string {
  if (blockedOwner === "music") {
    if (ownedBy === "clipping") {
      return "🎙️ A clipping session is active in this server. Stop it first with `/clipping stop` before playing music.";
    }
    return "🗣️ Text-to-speech is currently active in this server. It needs to stop before music can play.";
  }
  if (ownedBy === "music") {
    return "Music is currently playing in this server. Stop it first with `/music stop` before using this.";
  }
  return `Already in use by ${OWNER_LABELS[ownedBy]} in another voice channel in this server.`;
}
