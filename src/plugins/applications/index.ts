import { zApplicationsConfig } from "../../config/schemas/applications.js";
import { definePlugin } from "../../core/plugin.js";
import { getLogger } from "../../core/logger.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { loadApplicationsConfig, PLUGIN } from "./functions/config.js";
import { deleteRemovedOpeningPosts } from "./functions/post.js";
import { REMINDER_INTERVAL_MS, sendDueRsvpReminders } from "./functions/reminders.js";

const log = getLogger("applications");

/**
 * Forms (internal key `applications`, which it grew out of): members fill in custom multi-page
 * modal forms posted in a channel. Applications, RSVPs, questionnaires, polls, feedback, reports
 * and sign-ups are all forms; staff review responses in Discord or on the dashboard. Everything
 * is driven by components (see the APPLICATION_PREFIX handlers wired in bot.ts), so there are no
 * slash commands here (the bot is near Discord's 100-command limit).
 */
export const applicationsPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zApplicationsConfig,
  slashCommands: [],
  onLoad: async ({ client, configManager }) => {
    // Deleting a form on the dashboard should take its post down with it.
    configManager.onSave((guildId, config, previous) => {
      if (!previous) return;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      void deleteRemovedOpeningPosts(
        guild,
        loadApplicationsConfig(previous).openings,
        loadApplicationsConfig(config).openings,
      ).catch((error) => log.error(`[applications] Failed to remove deleted form posts for ${guildId}:`, error));
    });
    registerIntervalTask({ id: "forms:rsvp-reminders", intervalMs: REMINDER_INTERVAL_MS, run: async (c) => void (await sendDueRsvpReminders(c)) });
  },
  events: [],
});
