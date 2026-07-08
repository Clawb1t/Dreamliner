import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zStarboardConfig } from "../../config/schemas/starboard.js";
import { handleStarboardMessageDelete, handleStarboardReaction } from "./functions/starboard.js";

export const starboardPlugin = definePlugin({
  name: "starboard",
  configSchema: zStarboardConfig,
  slashCommands: [],
  events: [
    {
      name: Events.MessageReactionAdd,
      execute: async (client, reaction: unknown, user: unknown) => {
        await handleStarboardReaction(
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
        await handleStarboardReaction(
          client,
          reaction as import("discord.js").MessageReaction,
          user as import("discord.js").User,
          "remove",
        );
      },
    },
    {
      name: Events.MessageDelete,
      execute: async (client, message: unknown) => {
        await handleStarboardMessageDelete(client, message as import("discord.js").Message);
      },
    },
  ],
});
