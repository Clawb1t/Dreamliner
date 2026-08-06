import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zDreamCommandsConfig } from "../../config/schemas/plugins.js";
import { configManager } from "../../config/manager.js";
import { dreamCommandsDefaultOverrides } from "./defaultOverrides.js";
import { dreamCommandManageCommands } from "./commands/manage.js";
import { handleDreamCommandMessage } from "./functions/messageHandler.js";

export const dreamCommandsPlugin = definePlugin({
  name: "dream_commands",
  configSchema: zDreamCommandsConfig,
  defaultOverrides: dreamCommandsDefaultOverrides,
  slashCommands: dreamCommandManageCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleDreamCommandMessage(message as import("discord.js").Message, configManager);
      },
    },
  ],
});
