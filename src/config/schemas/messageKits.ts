import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/**
 * Message Kits: saved messages (classic text + embeds, or Components V2 layouts) built on the
 * dashboard, sent to channels, scheduled, and edited in place later. The kits themselves live in
 * the database (`message_kits`), not in guild config; this is only the plugin's settings.
 */
export const zMessageKitsConfig = z.strictObject({
  log_channel_id: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Optional channel for a log entry whenever a kit is sent, edited in place or deleted. Paste a Discord channel ID (Developer Mode → right-click channel → Copy Channel ID).",
    ),
  ping_on_form: z
    .boolean()
    .default(true)
    .describe("Ping the form's role (when it has one) when someone submits a kit form."),
  can_manage: boolPerm("create, edit and delete message kits on the dashboard"),
  can_send: boolPerm("send, schedule and update message kits on the dashboard"),
});

export type MessageKitsConfig = z.infer<typeof zMessageKitsConfig>;

export const zMessageKitsPluginSection = zPluginSection(zMessageKitsConfig.shape);
