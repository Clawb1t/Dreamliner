import { Events, type Message, type Role } from "discord.js";
import { zCharactersConfig } from "../../config/schemas/characters.js";
import { definePlugin } from "../../core/plugin.js";
import { charactersCommands } from "./commands.js";
import { PLUGIN } from "./constants.js";
import { handleCharacterMessage, handleCharacterRoleDelete } from "./functions/listener.js";

/**
 * Characters: AI roleplay characters made on the dashboard (bridge/webCharacters.ts). Members talk
 * to one by @mentioning its role, replying to it, saying its name or writing in its dedicated
 * channel; it answers through a webhook with its own name and avatar (DeepSeek, see
 * core/ai/deepseek.ts). Free servers get 2 characters and 100 replies a day; Dreamliner One raises
 * that to 25 and 3000.
 */
export const charactersPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zCharactersConfig,
  slashCommands: charactersCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (client, message: unknown) => {
        await handleCharacterMessage(client, message as Message);
      },
    },
    {
      name: Events.GuildRoleDelete,
      execute: async (_client, role: unknown) => {
        await handleCharacterRoleDelete(role as Role);
      },
    },
  ],
});
