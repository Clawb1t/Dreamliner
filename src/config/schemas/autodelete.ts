import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";

export const zAutodeleteRule = z.strictObject({
  enabled: z.boolean().default(true).describe("Turn this rule on or off without deleting it."),
  name: z.string().max(80).default("").describe("Optional label in the dashboard."),
  channel_id: z.string().min(1).describe("Channel where messages are auto-deleted after the delay."),
  delay_seconds: z
    .number()
    .int()
    .min(1)
    .max(604800)
    .default(60)
    .describe("How long to wait before deleting a message, in seconds."),
});

export const zAutodeleteConfig = z.strictObject({
  can_manage: boolPerm("manage autodelete rules").describe(
    "Vestigial. Dashboard routes gate on Discord Manage Server, not this flag. Kept for /permissions consistency.",
  ),
  rules: z.array(zAutodeleteRule).default([]).describe("Channels with auto-delete enabled."),
});

export type AutodeleteRule = z.infer<typeof zAutodeleteRule>;
export type AutodeleteConfig = z.infer<typeof zAutodeleteConfig>;
