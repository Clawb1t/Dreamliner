import type { VoiceState } from "discord.js";
import { getSession, leaveChannel } from "./session.js";

/**
 * No existing plugin in this codebase watches VoiceStateUpdate to detect an emptied channel (TTS
 * only ever tears down on an idle playback timer or a forced disconnect) — this is genuinely new.
 * Leaves the moment its channel has no non-bot members left, whether actively recording or just
 * idling post /clipping stop — there's no reason to sit in an empty channel either way.
 */
export function handleClippingVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  const guildId = newState.guild.id;
  const session = getSession(guildId);
  if (!session) return;

  const relevantChannelId = session.channelId;
  if (oldState.channelId !== relevantChannelId && newState.channelId !== relevantChannelId) return;

  const channel = newState.guild.channels.cache.get(relevantChannelId);
  if (!channel || !channel.isVoiceBased()) {
    leaveChannel(guildId, "channel gone");
    return;
  }

  const humanMembers = channel.members.filter((member) => !member.user.bot);
  if (humanMembers.size === 0) {
    leaveChannel(guildId, "channel empty");
  }
}
