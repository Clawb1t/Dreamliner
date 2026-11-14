import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zSocialConfig } from "../../config/schemas/social.js";
import { socialCommands } from "./commands.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { pollAllWatchers } from "./functions/poll.js";
import { pollAllTwitchWatchers } from "./functions/pollTwitch.js";
import { pruneSocialDeliveries } from "./functions/deliveries.js";
import {
  SOCIAL_MILESTONE_FIRST_POLL_DELAY_MS,
  SOCIAL_MILESTONE_POLL_INTERVAL_MS,
  pollSubscriberMilestones,
} from "./functions/milestoneNotify.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("social");

const POLL_INTERVAL_MS = 5 * 60_000;
/** "Went live" is more time-sensitive than an upload/post, so Twitch polls more often. */
const TWITCH_POLL_INTERVAL_MS = 2 * 60_000;
const PRUNE_INTERVAL_MS = 12 * 60 * 60_000;

export const socialPlugin = definePlugin({
  name: "social",
  configSchema: zSocialConfig,
  slashCommands: socialCommands,
  onLoad: async (ctx) => {
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
    registerIntervalTask({
      id: "social:milestones",
      intervalMs: SOCIAL_MILESTONE_POLL_INTERVAL_MS,
      run: pollSubscriberMilestones,
    });
    registerIntervalTask({
      id: "social:prune",
      intervalMs: PRUNE_INTERVAL_MS,
      run: async () => {
        await pruneSocialDeliveries();
      },
    });
    ctx.client.once(Events.ClientReady, (client) => {
      setTimeout(() => {
        pollSubscriberMilestones(client).catch((error: unknown) => log.warn("[social] subscriber milestone check failed:", error));
      }, SOCIAL_MILESTONE_FIRST_POLL_DELAY_MS).unref?.();
    });
  },
});
