import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";

export const zTtsConfig = z.strictObject({
  can_speak: boolPerm("use /tts to make the bot join their voice channel and speak text aloud"),
  voice: z
    .string()
    .max(100)
    .default("")
    .describe(
      "Default Piper voice id (filename without .onnx). Empty uses PIPER_DEFAULT_VOICE (en_US-lessac-medium unless overridden). Members can override this per-request with the command's voice option, which autocompletes from the installed voices.",
    ),
  max_characters: z
    .number()
    .int()
    .min(20)
    .max(4000)
    .default(300)
    .describe("Maximum characters accepted per /tts request."),
  cooldown_seconds: z
    .number()
    .min(0)
    .max(600)
    .default(0.5)
    .describe("Per-member cooldown between /tts uses, in seconds. Accepts fractional values (e.g. 0.5)."),
});

export type TtsConfig = z.infer<typeof zTtsConfig>;
