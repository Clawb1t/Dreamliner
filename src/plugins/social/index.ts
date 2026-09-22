import { definePlugin } from "../../core/plugin.js";
import { zSocialConfig } from "../../config/schemas/social.js";
import { socialCommands } from "./commands.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { pollAllWatchers } from "./functions/poll.js";
import { pollAllTwitchWatchers } from "./functions/pollTwitch.js";

const POLL_INTERVAL_MS = 5 * 60_000;
/** "Went live" is more time-sensitive than an upload/post, so Twitch polls more often. */
const TWITCH_POLL_INTERVAL_MS = 2 * 60_000;

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
    registerIntervalTask({
      id: "social:twitch-poll",
      intervalMs: TWITCH_POLL_INTERVAL_MS,
      run: pollAllTwitchWatchers,
    });
  },
});
