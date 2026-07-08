import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import {
  handleMemberJoin,
  handleMemberLeave,
  handleMemberUpdate,
  handleMessageCreate,
  handleMessageDelete,
  handleMessageUpdate,
  handleThreadCreate,
  handleThreadUpdate,
  handleVoiceStateUpdate,
} from "./functions/handlers.js";

export const logsPlugin = definePlugin({
  name: "logs",
  slashCommands: [],
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        await handleMemberJoin(member as import("discord.js").GuildMember);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        await handleMemberLeave(member as import("discord.js").GuildMember);
      },
    },
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        await handleMemberUpdate(
          oldMember as import("discord.js").GuildMember,
          newMember as import("discord.js").GuildMember,
        );
      },
    },
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleMessageCreate(message as import("discord.js").Message);
      },
    },
    {
      name: Events.MessageUpdate,
      execute: async (_client, oldMessage: unknown, newMessage: unknown) => {
        await handleMessageUpdate(
          oldMessage as import("discord.js").Message | import("discord.js").PartialMessage,
          newMessage as import("discord.js").Message | import("discord.js").PartialMessage,
        );
      },
    },
    {
      name: Events.MessageDelete,
      execute: async (_client, message: unknown) => {
        await handleMessageDelete(message as import("discord.js").Message | import("discord.js").PartialMessage);
      },
    },
    {
      name: Events.VoiceStateUpdate,
      execute: async (_client, oldState: unknown, newState: unknown) => {
        await handleVoiceStateUpdate(
          oldState as import("discord.js").VoiceState,
          newState as import("discord.js").VoiceState,
        );
      },
    },
    {
      name: Events.ThreadCreate,
      execute: async (_client, thread: unknown) => {
        await handleThreadCreate(thread as import("discord.js").AnyThreadChannel);
      },
    },
    {
      name: Events.ThreadUpdate,
      execute: async (_client, oldThread: unknown, newThread: unknown) => {
        await handleThreadUpdate(
          oldThread as import("discord.js").AnyThreadChannel,
          newThread as import("discord.js").AnyThreadChannel,
        );
      },
    },
  ],
});
