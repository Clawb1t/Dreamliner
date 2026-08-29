import { StreamType } from "@discordjs/voice";
import type { TtsConfig } from "../../../config/schemas/tts.js";
import { synthesizeWithPiper } from "./piper.js";
import { resampleToDiscordPcm } from "./resample.js";
import { resolveDefaultVoice } from "./piperSetup.js";

export type PreparedAudio = { buffer: Buffer; inputType: StreamType };
export type SynthResult = { audio: PreparedAudio } | { error: string };

/** Synthesizes `text` with Piper, ready to queue for playback. */
export async function synthesize(text: string, config: TtsConfig, requestedVoice: string | null): Promise<SynthResult> {
  const voiceId = requestedVoice || config.voice || resolveDefaultVoice();

  const spoken = await synthesizeWithPiper(text, voiceId);
  if ("error" in spoken) return spoken;

  let pcm: Buffer;
  try {
    pcm = await resampleToDiscordPcm(spoken.pcm, spoken.sampleRate);
  } catch (error) {
    return { error: `Could not process Piper audio: ${error instanceof Error ? error.message : String(error)}` };
  }

  return { audio: { buffer: pcm, inputType: StreamType.Raw } };
}
