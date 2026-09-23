import { zApplicationsConfig } from "../../config/schemas/applications.js";
import { definePlugin } from "../../core/plugin.js";
import { PLUGIN } from "./functions/config.js";

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
  events: [],
});
