import { Routes, type VoiceBasedChannel } from "discord.js";

/**
 * discord.js does not wrap the "Modify Voice Channel Status" endpoint, so this
 * hits the REST route directly. See:
 * https://discord.com/developers/docs/resources/channel#modify-voice-channel-status
 */
export async function setVoiceChannelStatus(channel: VoiceBasedChannel, status: string | null): Promise<boolean> {
  try {
    await channel.client.rest.put(`${Routes.channel(channel.id)}/voice-status` as `/channels/${string}`, {
      body: { status },
    });
    return true;
  } catch {
    return false;
  }
}
