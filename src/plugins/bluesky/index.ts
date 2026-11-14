import { Events, type Message, type MessageReaction, type User } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zBlueskyConfig } from "../../config/schemas/bluesky.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { blueskyCommands } from "./commands.js";
import { handleBlueskyLinkMessage } from "./functions/linkCards.js";
import { MILESTONE_FIRST_POLL_DELAY_MS, MILESTONE_POLL_INTERVAL_MS, pollFollowerMilestones } from "./functions/milestoneNotify.js";
import { pruneOauthStates } from "./functions/oauth.js";
import { handleBlueskyReaction } from "./functions/reactions.js";
import { pruneDeliveries } from "./functions/store.js";
import { startBlueskyStream } from "./functions/stream.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("bluesky");

const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;

export const blueskyPlugin = definePlugin({
  name: "bluesky",
  configSchema: zBlueskyConfig,
  slashCommands: blueskyCommands,
  events: [
    {
      name: Events.MessageReactionAdd,
      execute: async (client, reaction: unknown, user: unknown) => {
        await handleBlueskyReaction(client, reaction as MessageReaction, user as User, "add");
      },
    },
    {
      name: Events.MessageReactionRemove,
      execute: async (client, reaction: unknown, user: unknown) => {
        await handleBlueskyReaction(client, reaction as MessageReaction, user as User, "remove");
      },
    },
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleBlueskyLinkMessage(message as Message);
      },
    },
  ],
  onLoad: async (ctx) => {
    registerIntervalTask({
      id: "bluesky:prune",
      intervalMs: PRUNE_INTERVAL_MS,
      run: async () => {
        await pruneDeliveries();
        await pruneOauthStates();
      },
    });
    registerIntervalTask({
      id: "bluesky:milestones",
      intervalMs: MILESTONE_POLL_INTERVAL_MS,
      run: async (client) => {
        await pollFollowerMilestones(client);
      },
    });
    ctx.client.once(Events.ClientReady, (client) => {
      startBlueskyStream(client).catch((error: unknown) => log.error("[bluesky] failed to start the Jetstream stream:", error));
      setTimeout(() => {
        pollFollowerMilestones(client).catch((error: unknown) => log.warn("[bluesky] follower milestone check failed:", error));
      }, MILESTONE_FIRST_POLL_DELAY_MS).unref?.();
    });
  },
});
