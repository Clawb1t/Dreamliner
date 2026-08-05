import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zAutorepliesConfig } from "../../config/schemas/plugins.js";
import { autorepliesDefaultOverrides } from "./defaultOverrides.js";
import { autorepliesCommands } from "./commands.js";
import { handleAutoreplyMessage } from "./functions/handlers.js";

export const autorepliesPlugin = definePlugin({
  name: "autoreplies",
  configSchema: zAutorepliesConfig,
  defaultOverrides: autorepliesDefaultOverrides,
  slashCommands: autorepliesCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleAutoreplyMessage(message as import("discord.js").Message);
      },
    },
  ],
});
