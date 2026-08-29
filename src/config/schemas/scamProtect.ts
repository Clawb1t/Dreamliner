import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";
import { zPluginOverride } from "./pluginSection.js";

export const zScamProtectConfig = z.strictObject({
  channel_id: channelId(
    "Managed by Dreamliner after setup. Not editable in the dashboard.",
  ),
  warning_message_id: z
    .string()
    .optional()
    .describe("Managed by Dreamliner after setup. Not editable in the dashboard."),
  channel_name: z
    .string()
    .max(100)
    .default("")
    .describe(
      "Full name for the honeypot channel. Empty uses an auto-generated name built to look ordinary " +
        "and evade naive scam-bot channel-name filters. If you set your own, avoid anything that " +
        "signals 'trap' or 'moderation' (e.g. containing 'scam', 'verify', 'mod'); an obvious name " +
        "makes it easier for scam/raid bots to recognize and simply avoid this channel.",
    ),
  staff_level: z
    .number()
    .int()
    .min(0)
    .default(50)
    .describe("Members at this level or higher are ignored when ignore_staff is true."),
  ignore_staff: z
    .boolean()
    .default(true)
    .describe("Ignore members at staff_level+ and members with Ban Members / Administrator."),
  can_setup: boolPerm("create or repair the Scam Protect honeypot channel"),
  can_status: boolPerm("view Scam Protect status"),
});

export const zScamProtectPluginSection = z.strictObject({
  enabled: z
    .boolean()
    .optional()
    .describe(
      "Opt-in honeypot. Leave off until you enable it in the dashboard or run /scamprotect setup (creates the channel).",
    ),
  config: zScamProtectConfig.partial().optional(),
  overrides: z.array(zPluginOverride).optional(),
  replaceDefaultOverrides: z
    .boolean()
    .optional()
    .describe("When true, ignore Dreamliner's built-in default level grants for this plugin."),
});

export type ScamProtectConfig = z.infer<typeof zScamProtectConfig>;
