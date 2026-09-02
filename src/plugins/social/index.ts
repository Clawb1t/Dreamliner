import { definePlugin } from "../../core/plugin.js";
import { zSocialConfig } from "../../config/schemas/social.js";
import { socialCommands } from "./commands.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { pollAllWatchers } from "./functions/poll.js";

const POLL_INTERVAL_MS = 5 * 60_000;

export const socialPlugin = definePlugin({
  name: "social",
  configSchema: zSocialConfig,
  slashCommands: socialCommands,
  onLoad: async () => {
    registerIntervalTask({
      id: "social:youtube-poll",
      intervalMs: POLL_INTERVAL_MS,
      run: pollAllWatchers,
    });
  },
});
