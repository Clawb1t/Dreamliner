import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zCountingConfig } from "../../config/schemas/plugins.js";
import { countingCommands } from "./commands.js";
import { handleCountingMessage } from "./functions/handlers.js";

export const countingPlugin = definePlugin({
  name: "counting",
  configSchema: zCountingConfig,
  slashCommands: countingCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleCountingMessage(message as import("discord.js").Message);
      },
    },
  ],
});
