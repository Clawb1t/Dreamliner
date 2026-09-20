import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zGiveawaysConfig } from "../../config/schemas/giveaways.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { getLogger } from "../../core/logger.js";
import { giveawaysCommands } from "./commands.js";
import { processDueGiveaways } from "./functions/scheduler.js";
import { handleGiveawayReaction } from "./functions/handlers.js";

const log = getLogger("giveaways");

export const giveawaysPlugin = definePlugin({
  name: "giveaways",
  configSchema: zGiveawaysConfig,
  slashCommands: giveawaysCommands,
  events: [
    {
      name: Events.MessageReactionAdd,
      execute: async (client, reaction: unknown, user: unknown) => {
        await handleGiveawayReaction(
          client,
          reaction as import("discord.js").MessageReaction,
          user as import("discord.js").User,
          "add",
        );
      },
    },
    {
      name: Events.MessageReactionRemove,
      execute: async (client, reaction: unknown, user: unknown) => {
        await handleGiveawayReaction(
          client,
          reaction as import("discord.js").MessageReaction,
          user as import("discord.js").User,
          "remove",
        );
      },
    },
  ],
  onLoad: async (ctx) => {
    registerIntervalTask({
      id: "giveaways:due",
      intervalMs: 30_000,
      run: processDueGiveaways,
    });
    // Restart catch-up: resolve any giveaway that came due while the bot was offline immediately,
    // instead of waiting for the next 30s tick.
    void processDueGiveaways(ctx.client).catch((err) => {
      log.error("Restart catch-up pass for due giveaways failed:", err);
    });
  },
});

export { handleGiveawayEnterButton, handleGiveawayClaimButton } from "./functions/handlers.js";
export { GIVEAWAY_ENTER_PREFIX, GIVEAWAY_CLAIM_PREFIX } from "./functions/customIds.js";
export { handleGiveawayAutocomplete } from "./commands.js";
