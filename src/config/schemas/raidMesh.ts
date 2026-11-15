import { z } from "zod";
import { channelId } from "../schemaHelp.js";

/**
 * Raid Defense Mesh: opt-in pairing between servers (see src/plugins/raid_mesh/). Linking,
 * invites, and alert history are all operational data (src/db/schema.ts's
 * raidMeshLinks/raidMeshInvites), not config. The only settings beyond the standard plugin
 * `enabled` toggle are where to post incoming mesh alerts.
 */
export const zRaidMeshConfig = z.strictObject({
  alert_channel_id: channelId(
    "Where incoming Raid Defense Mesh alerts from linked servers are posted. Defaults to the moderation log channel when unset.",
  ),
  watchlist: z
    .strictObject({
      enabled: z
        .boolean()
        .default(true)
        .describe("Remember the accounts named in an incoming mesh alert and flag them if they join this server."),
      hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .default(24)
        .describe("How long accounts from an incoming alert stay on the watchlist (1 to 168 hours)."),
    })
    .default({}),
});

export type RaidMeshConfig = z.infer<typeof zRaidMeshConfig>;
