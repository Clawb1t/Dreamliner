import { zApplicationsConfig } from "../../config/schemas/applications.js";
import { definePlugin } from "../../core/plugin.js";
import { getLogger } from "../../core/logger.js";
import { loadApplicationsConfig, PLUGIN } from "./functions/config.js";
import { deleteRemovedOpeningPosts } from "./functions/post.js";

const log = getLogger("applications");

/**
 * Applications: members apply for roles/positions through custom multi-page modal forms posted in
 * a channel, and staff accept or deny them from a review channel or the dashboard. Everything is
 * driven by components (see the APPLICATION_PREFIX handlers wired in bot.ts), so there are no
 * slash commands or gateway events here.
 */
export const applicationsPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zApplicationsConfig,
  slashCommands: [],
  onLoad: async ({ client, configManager }) => {
    // Deleting an opening on the dashboard should take its apply post down with it.
    configManager.onSave((guildId, config, previous) => {
      if (!previous) return;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      void deleteRemovedOpeningPosts(
        guild,
        loadApplicationsConfig(previous).openings,
        loadApplicationsConfig(config).openings,
      ).catch((error) => log.error(`[applications] Failed to remove deleted opening posts for ${guildId}:`, error));
    });
  },
  events: [],
});
