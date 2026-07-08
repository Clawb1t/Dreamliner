import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zCensorConfig } from "../../config/schemas/plugins.js";
import { censorDefaultOverrides } from "./defaultOverrides.js";
import { censorCommands } from "./commands.js";
import { handleCensorMessage, handleCensorMessageUpdate } from "./functions/handlers.js";

export const censorPlugin = definePlugin({
  name: "censor",
  configSchema: zCensorConfig,
  defaultOverrides: censorDefaultOverrides,
  slashCommands: censorCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleCensorMessage(message as import("discord.js").Message);
      },
    },
    {
      name: Events.MessageUpdate,
      execute: async (_client, oldMessage: unknown, newMessage: unknown) => {
        await handleCensorMessageUpdate(
          oldMessage as import("discord.js").Message | import("discord.js").PartialMessage,
          newMessage as import("discord.js").Message | import("discord.js").PartialMessage,
        );
      },
    },
  ],
});
