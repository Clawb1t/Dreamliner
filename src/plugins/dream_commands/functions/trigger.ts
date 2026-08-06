import type { ChatInputCommandInteraction, GuildTextBasedChannel, Message } from "discord.js";

/**
 * Minimal trigger surface used by the Dreamcode Discord host.
 * Real messages satisfy this; slash invocations use a shim.
 */
export type DreamTrigger = {
  id: string;
  content: string;
  url: string;
  createdAt: Date;
  pinned: boolean;
  editable: boolean;
  channel: Message["channel"];
  author: { id: string };
  reply: (options: string | Record<string, unknown>) => Promise<Message<boolean>>;
  delete: () => Promise<Message<boolean> | void>;
  react: (emoji: string) => Promise<unknown>;
  edit: (options: string | Record<string, unknown>) => Promise<Message<boolean>>;
};

export function messageAsTrigger(message: Message): DreamTrigger {
  return message as unknown as DreamTrigger;
}

function asContent(options: string | Record<string, unknown>): string {
  if (typeof options === "string") return options;
  return typeof options.content === "string" ? options.content : "";
}

export async function createSlashTrigger(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  argText: string,
  options?: { ephemeral?: boolean },
): Promise<DreamTrigger & { didReply: () => boolean }> {
  const ephemeral = options?.ephemeral === true;
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral });
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) {
    throw new Error("Dreamcode slash commands require a text channel.");
  }

  let replyMessage: Message | null = null;
  let usedReply = false;
  const content = argText ? `/${commandName} ${argText}` : `/${commandName}`;

  const trigger: DreamTrigger & { didReply: () => boolean } = {
    id: interaction.id,
    content,
    url: "",
    createdAt: new Date(),
    pinned: false,
    editable: true,
    channel: channel as GuildTextBasedChannel,
    author: { id: interaction.user.id },
    didReply: () => usedReply,
    reply: async (options) => {
      usedReply = true;
      const text = asContent(options);
      if (interaction.deferred && !interaction.replied) {
        replyMessage = (await interaction.editReply({ content: text })) as Message;
      } else if (!interaction.replied && !interaction.deferred) {
        replyMessage = (await interaction.reply({
          content: text,
          ephemeral,
          fetchReply: true,
        })) as Message;
      } else {
        replyMessage = (await interaction.followUp({
          content: text,
          ephemeral,
          fetchReply: true,
        })) as Message;
      }
      trigger.id = replyMessage.id;
      trigger.url = replyMessage.url;
      return replyMessage;
    },
    delete: async () => {
      if (replyMessage?.deletable) {
        await replyMessage.delete().catch(() => null);
        return;
      }
      await interaction.deleteReply().catch(() => null);
    },
    react: async (emoji) => {
      if (!replyMessage) {
        usedReply = true;
        replyMessage = (await interaction.editReply({ content: "\u200b" })) as Message;
      }
      await replyMessage.react(emoji);
    },
    edit: async (options) => {
      usedReply = true;
      const text = asContent(options);
      replyMessage = (await interaction.editReply({ content: text })) as Message;
      trigger.id = replyMessage.id;
      trigger.url = replyMessage.url;
      return replyMessage;
    },
  };

  return trigger;
}
