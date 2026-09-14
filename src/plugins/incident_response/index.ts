import { Events, type Guild, type GuildAuditLogsEntry } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zIncidentResponseConfig } from "../../config/schemas/incidentResponse.js";
import { incidentResponseCommands } from "./commands.js";
import { handleAuditLogEntry } from "./functions/nukeDetect.js";
import { sweepExpiredLockdowns } from "./functions/lockdown.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("incident_response");

export const incidentResponsePlugin = definePlugin({
  name: "incident_response",
  configSchema: zIncidentResponseConfig,
  slashCommands: incidentResponseCommands,
  onLoad: async ({ client }) => {
    setInterval(() => {
      sweepExpiredLockdowns((guildId) => client.guilds.cache.get(guildId) ?? null).catch((err) => {
        log.error("Lockdown sweep failed:", err);
      });
    }, 60_000);
  },
  events: [
    {
      name: Events.GuildAuditLogEntryCreate,
      execute: async (client, entry: unknown, guild: unknown) => {
        await handleAuditLogEntry(client, entry as GuildAuditLogsEntry, guild as Guild);
      },
    },
  ],
});
