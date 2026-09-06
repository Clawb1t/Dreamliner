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
});

export type RaidMeshConfig = z.infer<typeof zRaidMeshConfig>;
