import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";

export const zTtsConfig = z.strictObject({
  can_speak: boolPerm("have their messages in the TTS text channel (and their own /tts voice picks) spoken aloud"),
  can_manage_channel: boolPerm("set or clear the TTS auto-speak text channel with /tts channel"),
  text_channel_id: channelId(
    "Text channel where any message from a member in a voice channel is automatically spoken there. Set with /tts channel set.",
  ),
  voice: z
    .string()
    .max(100)
    .default("")
    .describe(
      "Server default Piper voice id (filename without .onnx), used for members who haven't picked one with /tts voice. Empty uses PIPER_DEFAULT_VOICE (en_US-hfc_male-medium unless overridden).",
    ),
  max_characters: z
    .number()
    .int()
    .min(20)
    .max(4000)
    .default(300)
    .describe("Maximum characters spoken per message in the TTS text channel. Longer messages are truncated."),
  cooldown_seconds: z
    .number()
    .min(0)
    .max(600)
    .default(0.5)
    .describe("Per-member cooldown between spoken messages, in seconds. Accepts fractional values (e.g. 0.5)."),
});

export type TtsConfig = z.infer<typeof zTtsConfig>;
