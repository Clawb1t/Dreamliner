import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zAutoreactionsConfig } from "../../config/schemas/plugins.js";
import { autoreactionsDefaultOverrides } from "./defaultOverrides.js";
import { autoreactionsCommands } from "./commands.js";
import { handleAutoreactionMessage } from "./functions/handlers.js";

export const autoreactionsPlugin = definePlugin({
  name: "autoreactions",
  configSchema: zAutoreactionsConfig,
  defaultOverrides: autoreactionsDefaultOverrides,
  slashCommands: autoreactionsCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleAutoreactionMessage(message as import("discord.js").Message);
      },
    },
  ],
});
