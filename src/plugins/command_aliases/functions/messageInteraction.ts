import {
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type Message,
  type MessageEditOptions,
  type MessageReplyOptions,
} from "discord.js";
import { createStoredOnlyOptionsProxy } from "./optionsProxy.js";

function toMessageReply(options: InteractionReplyOptions | InteractionEditReplyOptions): MessageReplyOptions | MessageEditOptions {
  const { ephemeral: _ephemeral, fetchReply: _fetchReply, flags: _flags, ...rest } = options as InteractionReplyOptions;
  return rest;
}

export function createMessageAliasInteraction(
  message: Message,
  commandName: string,
  storedOptions: Record<string, unknown>,
): ChatInputCommandInteraction {
  let replyMessage: Message | null = null;
  let replied = false;
  let deferred = false;

  const interaction = {
    commandName,
    commandId: "alias",
    commandType: 1,
    guildId: message.guildId,
    channelId: message.channelId,
    user: message.author,
    member: message.member,
    guild: message.guild,
    channel: message.channel,
    client: message.client,
    inGuild: () => Boolean(message.guild),
    inCachedGuild: () => Boolean(message.guild),
    isChatInputCommand: () => true as const,
    isRepliable: () => true as const,
    get replied() {
      return replied;
    },
    get deferred() {
      return deferred;
    },
    options: createStoredOnlyOptionsProxy(message.client, storedOptions),
    reply: async (options: InteractionReplyOptions) => {
      replied = true;
      replyMessage = await message.reply(toMessageReply(options) as MessageReplyOptions);
      return replyMessage as unknown as import("discord.js").InteractionResponse<boolean>;
    },
    deferReply: async () => {
      deferred = true;
    },
    editReply: async (options: InteractionEditReplyOptions) => {
      const payload = toMessageReply(options);
      if (replyMessage) {
        await replyMessage.edit(payload as MessageEditOptions);
      } else {
        replyMessage = await message.reply(payload as MessageReplyOptions);
        replied = true;
      }
      return replyMessage as unknown as import("discord.js").Message<boolean>;
    },
    followUp: async (options: InteractionReplyOptions) => {
      return message.reply(toMessageReply(options) as MessageReplyOptions) as unknown as import("discord.js").Message<boolean>;
    },
    deleteReply: async () => {
      await replyMessage?.delete().catch(() => null);
    },
  };

  return interaction as unknown as ChatInputCommandInteraction;
}
