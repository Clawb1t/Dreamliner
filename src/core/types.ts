import type {
  ChatInputCommandInteraction,
  Client,
  Collection,
  GuildMember,
  Interaction,
  Message,
  MessageContextMenuCommandInteraction,
} from "discord.js";
import type { ZodType } from "zod";
import type { GuildConfig } from "../config/schemas/guild.js";
import type { ConfigManager } from "../config/manager.js";

export type EmojiKind = "success" | "error" | "neutral";

export type SlashCommandContext = {
  interaction: ChatInputCommandInteraction;
  guildConfig: GuildConfig;
  pluginConfig: Record<string, unknown>;
  client: Client;
  configManager: ConfigManager;
  ephemeral: boolean;
};

export type SlashCommandDefinition = {
  data: {
    name: string;
    description: string;
    toJSON: () => unknown;
  };
  plugin: string;
  permission?: string;
  manageServer?: boolean;
  discordPermissions?: bigint;
  execute: (ctx: SlashCommandContext) => Promise<void>;
};

export type ContextMenuCommandContext = {
  interaction: MessageContextMenuCommandInteraction;
  guildConfig: GuildConfig;
  pluginConfig: Record<string, unknown>;
  client: Client;
  configManager: ConfigManager;
};

export type ContextMenuCommandDefinition = {
  data: {
    name: string;
    toJSON: () => unknown;
  };
  plugin: string;
  permission?: string;
  manageServer?: boolean;
  discordPermissions?: bigint;
  execute: (ctx: ContextMenuCommandContext) => Promise<void>;
};

export type EventHandler = {
  name: string;
  once?: boolean;
  execute: (client: Client, ...args: unknown[]) => Promise<void>;
};

export type DreamlinerPlugin = {
  name: string;
  configSchema?: ZodType;
  dependencies?: string[];
  slashCommands: SlashCommandDefinition[];
  contextMenuCommands?: ContextMenuCommandDefinition[];
  events?: EventHandler[];
  onLoad?: (ctx: PluginLoadContext) => Promise<void>;
};

export type PluginLoadContext = {
  client: Client;
  configManager: ConfigManager;
};

export type ButtonHandler = (
  interaction: Interaction,
  customId: string,
) => Promise<void>;

export type InteractionStore = {
  buttonHandlers: Collection<string, ButtonHandler>;
};

export type BotContext = {
  client: Client;
  configManager: ConfigManager;
  plugins: DreamlinerPlugin[];
  commands: Collection<string, SlashCommandDefinition>;
  contextMenuCommands: Collection<string, ContextMenuCommandDefinition>;
  interactionStore: InteractionStore;
};

export type ArchivedMessage = {
  id: string;
  authorId: string;
  authorTag: string;
  content: string;
  createdAt: string;
  attachments: string[];
};

export type LogFn = (guildId: string, message: string) => Promise<void>;

export type { GuildConfig, ChatInputCommandInteraction, MessageContextMenuCommandInteraction, GuildMember, Message };
