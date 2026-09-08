import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zAutomodConfig } from "../../config/schemas/automod.js";
import {
  handleAutomodMemberAdd,
  handleAutomodMessage,
  handleAutomodMessageUpdate,
} from "./functions/handlers.js";
import { handleNativeAutomodExecution } from "./functions/nativeSync.js";

export const automodPlugin = definePlugin({
  name: "automod",
  configSchema: zAutomodConfig,
  slashCommands: [],
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleAutomodMessage(message as import("discord.js").Message);
      },
    },
    {
      name: Events.MessageUpdate,
      execute: async (_client, oldMessage: unknown, newMessage: unknown) => {
        await handleAutomodMessageUpdate(
          oldMessage as import("discord.js").Message,
          newMessage as import("discord.js").Message,
        );
      },
    },
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleAutomodMemberAdd(member as import("discord.js").GuildMember);
      },
    },
    {
      name: Events.AutoModerationActionExecution,
      execute: async (_client, execution: unknown) => {
        await handleNativeAutomodExecution(execution as import("discord.js").AutoModerationActionExecution);
      },
    },
  ],
});
