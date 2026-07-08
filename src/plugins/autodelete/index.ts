import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zAutodeleteConfig } from "../../config/schemas/plugins.js";
import { autodeleteDefaultOverrides } from "./defaultOverrides.js";
import { autodeleteCommands } from "./commands.js";
import { handleAutodeleteMessage } from "./functions/handlers.js";

export const autodeletePlugin = definePlugin({
  name: "autodelete",
  configSchema: zAutodeleteConfig,
  defaultOverrides: autodeleteDefaultOverrides,
  slashCommands: autodeleteCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleAutodeleteMessage(message as import("discord.js").Message);
      },
    },
  ],
});
