import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zAutothreadsConfig } from "../../config/schemas/plugins.js";
import { autothreadsDefaultOverrides } from "./defaultOverrides.js";
import { autothreadsCommands } from "./commands.js";
import { handleAutothreadMessage } from "./functions/handlers.js";

export const autothreadsPlugin = definePlugin({
  name: "autothreads",
  configSchema: zAutothreadsConfig,
  defaultOverrides: autothreadsDefaultOverrides,
  slashCommands: autothreadsCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleAutothreadMessage(message as import("discord.js").Message);
      },
    },
  ],
});
