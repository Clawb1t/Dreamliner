import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zAutomodConfig } from "../../config/schemas/plugins.js";
import { automodDefaultOverrides } from "./defaultOverrides.js";
import { automodCommands } from "./commands.js";
import { handleAutomodMemberAdd, handleAutomodMessage } from "./functions/handlers.js";

export const automodPlugin = definePlugin({
  name: "automod",
  configSchema: zAutomodConfig,
  defaultOverrides: automodDefaultOverrides,
  slashCommands: automodCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleAutomodMessage(message as import("discord.js").Message);
      },
    },
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleAutomodMemberAdd(member as import("discord.js").GuildMember);
      },
    },
  ],
});
