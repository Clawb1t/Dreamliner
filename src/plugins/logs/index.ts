import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import {
  handleChannelCreate,
  handleChannelDelete,
  handleChannelUpdate,
  handleEmojiCreate,
  handleEmojiDelete,
  handleEmojiUpdate,
  handleGuildBanAdd,
  handleGuildBanRemove,
  handleGuildUpdate,
  handleInviteCreate,
  handleInviteDelete,
  handleMemberJoin,
  handleMemberLeave,
  handleMemberUpdate,
  handleMessageBulkDelete,
  handleMessageCreate,
  handleMessageDelete,
  handleMessageUpdate,
  handleRoleCreate,
  handleRoleDelete,
  handleRoleUpdate,
  handleStickerCreate,
  handleStickerDelete,
  handleStickerUpdate,
  handleThreadCreate,
  handleThreadDelete,
  handleThreadUpdate,
  handleVoiceStateUpdate,
  handleWebhooksUpdate,
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
        await handleMessageDelete(
          message as import("discord.js").Message | import("discord.js").PartialMessage,
        );
      },
    },
    {
      name: Events.MessageBulkDelete,
      execute: async (_client, messages: unknown, channel: unknown) => {
        await handleMessageBulkDelete(
          messages as ReadonlyMap<string, import("discord.js").Message | import("discord.js").PartialMessage>,
          channel as { id: string; name?: string | null; guild: import("discord.js").Guild | null },
        );
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
    {
      name: Events.ThreadDelete,
      execute: async (_client, thread: unknown) => {
        await handleThreadDelete(thread as import("discord.js").AnyThreadChannel);
      },
    },
    {
      name: Events.GuildBanAdd,
      execute: async (_client, ban: unknown) => {
        await handleGuildBanAdd(ban as import("discord.js").GuildBan);
      },
    },
    {
      name: Events.GuildBanRemove,
      execute: async (_client, ban: unknown) => {
        await handleGuildBanRemove(ban as import("discord.js").GuildBan);
      },
    },
    {
      name: Events.ChannelCreate,
      execute: async (_client, channel: unknown) => {
        await handleChannelCreate(channel as import("discord.js").GuildBasedChannel);
      },
    },
    {
      name: Events.ChannelDelete,
      execute: async (_client, channel: unknown) => {
        await handleChannelDelete(channel as import("discord.js").GuildBasedChannel);
      },
    },
    {
      name: Events.ChannelUpdate,
      execute: async (_client, oldChannel: unknown, newChannel: unknown) => {
        await handleChannelUpdate(
          oldChannel as import("discord.js").GuildBasedChannel,
          newChannel as import("discord.js").GuildBasedChannel,
        );
      },
    },
    {
      name: Events.GuildRoleCreate,
      execute: async (_client, role: unknown) => {
        await handleRoleCreate(role as import("discord.js").Role);
      },
    },
    {
      name: Events.GuildRoleDelete,
      execute: async (_client, role: unknown) => {
        await handleRoleDelete(role as import("discord.js").Role);
      },
    },
    {
      name: Events.GuildRoleUpdate,
      execute: async (_client, oldRole: unknown, newRole: unknown) => {
        await handleRoleUpdate(
          oldRole as import("discord.js").Role,
          newRole as import("discord.js").Role,
        );
      },
    },
    {
      name: Events.GuildUpdate,
      execute: async (_client, oldGuild: unknown, newGuild: unknown) => {
        await handleGuildUpdate(
          oldGuild as import("discord.js").Guild,
          newGuild as import("discord.js").Guild,
        );
      },
    },
    {
      name: Events.GuildEmojiCreate,
      execute: async (_client, emoji: unknown) => {
        await handleEmojiCreate(emoji as import("discord.js").GuildEmoji);
      },
    },
    {
      name: Events.GuildEmojiDelete,
      execute: async (_client, emoji: unknown) => {
        await handleEmojiDelete(emoji as import("discord.js").GuildEmoji);
      },
    },
    {
      name: Events.GuildEmojiUpdate,
      execute: async (_client, oldEmoji: unknown, newEmoji: unknown) => {
        await handleEmojiUpdate(
          oldEmoji as import("discord.js").GuildEmoji,
          newEmoji as import("discord.js").GuildEmoji,
        );
      },
    },
    {
      name: Events.GuildStickerCreate,
      execute: async (_client, sticker: unknown) => {
        await handleStickerCreate(sticker as import("discord.js").Sticker);
      },
    },
    {
      name: Events.GuildStickerDelete,
      execute: async (_client, sticker: unknown) => {
        await handleStickerDelete(sticker as import("discord.js").Sticker);
      },
    },
    {
      name: Events.GuildStickerUpdate,
      execute: async (_client, oldSticker: unknown, newSticker: unknown) => {
        await handleStickerUpdate(
          oldSticker as import("discord.js").Sticker,
          newSticker as import("discord.js").Sticker,
        );
      },
    },
    {
      name: Events.InviteCreate,
      execute: async (_client, invite: unknown) => {
        await handleInviteCreate(invite as import("discord.js").Invite);
      },
    },
    {
      name: Events.InviteDelete,
      execute: async (_client, invite: unknown) => {
        await handleInviteDelete(invite as import("discord.js").Invite);
      },
    },
    {
      name: Events.WebhooksUpdate,
      execute: async (_client, channel: unknown) => {
        await handleWebhooksUpdate(
          channel as { id: string; name?: string | null; guild: import("discord.js").Guild | null },
        );
      },
    },
  ],
});
