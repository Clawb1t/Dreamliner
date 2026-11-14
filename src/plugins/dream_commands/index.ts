import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zDreamCommandsConfig } from "../../config/schemas/plugins.js";
import { dreamCommandManageCommands } from "./commands/manage.js";
import {
  dreamCommandsNeedResync,
  syncAllGuildDreamSlashCommands,
  syncGuildDreamSlashCommands,
} from "./functions/guildSlash.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("dream_commands");

export const dreamCommandsPlugin = definePlugin({
  name: "dream_commands",
  configSchema: zDreamCommandsConfig,
  slashCommands: dreamCommandManageCommands,
  onLoad: async ({ client, configManager }) => {
    // Turning the plugin on/off (from the dashboard or /plugin toggle) adds or removes the
    // server's custom commands in Discord.
    configManager.onSave((guildId, config) => {
      if (!client.isReady()) return;
      if (!dreamCommandsNeedResync(guildId, pluginEnabled(config, "dream_commands"))) return;
      void syncGuildDreamSlashCommands(client, guildId).catch((error) => {
        log.error(`[dream_commands] Re-sync after config save failed for ${guildId}:`, error);
      });
    });
  },
  events: [
    {
      name: Events.ClientReady,
      once: true,
      execute: async (client) => {
        const c = client as import("discord.js").Client;
        // Ensure application id is available for guild command routes.
        await c.application?.fetch().catch(() => null);
        await syncAllGuildDreamSlashCommands(c);
        log.info("[dream_commands] Synced guild custom slash commands.");
      },
    },
    {
      name: Events.GuildCreate,
      execute: async (client, guild) => {
        const g = guild as import("discord.js").Guild;
        try {
          await syncGuildDreamSlashCommands(client as import("discord.js").Client, g.id);
        } catch (error) {
          log.error(`[dream_commands] GuildCreate sync failed for ${g.id}:`, error);
        }
      },
    },
  ],
});

export { handleDreamCommandSlash } from "./functions/run.js";
