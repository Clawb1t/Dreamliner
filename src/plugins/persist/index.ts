import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zPersistConfig } from "../../config/schemas/plugins.js";
import { persistDefaultOverrides } from "./defaultOverrides.js";
import { persistCommands } from "./commands.js";
import { handlePersistMessageDelete } from "./functions/handlers.js";

export const persistPlugin = definePlugin({
  name: "persist",
  configSchema: zPersistConfig,
  defaultOverrides: persistDefaultOverrides,
  slashCommands: persistCommands,
  events: [
    {
      name: Events.MessageDelete,
      execute: async (_client, message: unknown) => {
        await handlePersistMessageDelete(message as import("discord.js").Message | import("discord.js").PartialMessage);
      },
    },
  ],
});
