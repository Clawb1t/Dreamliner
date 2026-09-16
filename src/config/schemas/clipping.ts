import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";

/** The only valid clip lengths — must match /clip's `time` option choices exactly (commands.ts's
 *  TIME_CHOICES derives its values from this array), since this is also the ceiling `/clip [time]`
 *  is allowed to request and the size of the live rolling audio buffer kept while recording. */
export const CLIP_DURATION_CHOICES_SECONDS = [30, 60, 120, 240, 300] as const;
export type ClipDurationSeconds = (typeof CLIP_DURATION_CHOICES_SECONDS)[number];

export const zClippingConfig = z.strictObject({
  can_record: boolPerm("start a voice recording session with /clipping start"),
  can_clip: boolPerm("export a clip of recent voice activity with /clip"),
  clip_max_seconds: z
    .union([z.literal(30), z.literal(60), z.literal(120), z.literal(240), z.literal(300)])
    .default(300)
    .describe("Longest clip /clip can export. Matches /clip's own time choices (30 seconds, 1, 2, 4, or 5 minutes)."),
  retention_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe("Days an exported clip is kept before automatic deletion, unless its owner marks it to keep forever from the website."),
});

export type ClippingConfig = z.infer<typeof zClippingConfig>;
