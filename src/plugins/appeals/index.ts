import { zAppealsConfig } from "../../config/schemas/appeals.js";
import { definePlugin } from "../../core/plugin.js";
import { PLUGIN } from "./functions/config.js";

/**
 * Appeals: punished users ask for an infraction to be reviewed from the website
 * (/server/<id>/appeals), staff decide from a review channel or the dashboard's View Appeals page,
 * and approving can lift the punishment. The public side runs through the dashboard bridge
 * (bridge/webAppeals.ts) and the review side through components (APPEAL_PREFIX in bot.ts), so
 * there are no slash commands or gateway events here.
 */
export const appealsPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zAppealsConfig,
  slashCommands: [],
  events: [],
});
