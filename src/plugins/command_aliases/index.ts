import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zCommandAliasesConfig } from "../../config/schemas/plugins.js";
import { commandAliasesDefaultOverrides } from "./defaultOverrides.js";
import { aliasCommands } from "./commands/alias.js";
import { handleAliasMessage } from "./functions/messageHandler.js";
import { configManager } from "../../config/manager.js";

export const commandAliasesPlugin = definePlugin({
  name: "command_aliases",
  configSchema: zCommandAliasesConfig,
  defaultOverrides: commandAliasesDefaultOverrides,
  slashCommands: aliasCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleAliasMessage(message as import("discord.js").Message, configManager);
      },
    },
  ],
});
