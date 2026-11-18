import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zSocialConfig } from "../../config/schemas/social.js";
import { socialCommands } from "./commands.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { POLL_TICK_MS, pollFeedsTick } from "./feeds/poller.js";
import { TWITCH_POLL_INTERVAL_MS, pollTwitchFeeds } from "./feeds/twitch.js";
import { pruneFeeds } from "./feeds/store.js";
import { BANNER_REFRESH_MS, refreshCatalogBanners } from "./feeds/banners.js";
import {
  SOCIAL_MILESTONE_FIRST_POLL_DELAY_MS,
  SOCIAL_MILESTONE_POLL_INTERVAL_MS,
  pollSubscriberMilestones,
} from "./functions/milestoneNotify.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("social");

const PRUNE_INTERVAL_MS = 12 * 60 * 60_000;

/**
 * Notifications (internal name `social`): one feeds engine for YouTube, Twitch, RSS/Atom, Steam,
 * GitHub releases, status pages and the newswire catalogue. Feeds are built on the dashboard;
 * `/notifications` lists, tests, pauses and resumes them.
 */
export const socialPlugin = definePlugin({
  name: "social",
  configSchema: zSocialConfig,
  slashCommands: socialCommands,
  onLoad: async (ctx) => {
    registerIntervalTask({ id: "social:feeds", intervalMs: POLL_TICK_MS, run: pollFeedsTick });
    registerIntervalTask({ id: "social:twitch-poll", intervalMs: TWITCH_POLL_INTERVAL_MS, run: pollTwitchFeeds });
    registerIntervalTask({ id: "social:milestones", intervalMs: SOCIAL_MILESTONE_POLL_INTERVAL_MS, run: pollSubscriberMilestones });
    registerIntervalTask({
      id: "social:prune",
      intervalMs: PRUNE_INTERVAL_MS,
      run: async () => {
        await pruneFeeds();
      },
    });
    registerIntervalTask({ id: "social:catalog-banners", intervalMs: BANNER_REFRESH_MS, run: refreshCatalogBanners });
    ctx.client.once(Events.ClientReady, (client) => {
      refreshCatalogBanners().catch((error: unknown) => log.warn("[social] catalogue banner refresh failed:", error));
      setTimeout(() => {
        pollSubscriberMilestones(client).catch((error: unknown) => log.warn("[social] subscriber milestone check failed:", error));
      }, SOCIAL_MILESTONE_FIRST_POLL_DELAY_MS).unref?.();
    });
  },
});
