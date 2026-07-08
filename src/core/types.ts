import type {
  ChatInputCommandInteraction,
  Client,
  Collection,
  GuildMember,
  Interaction,
  Message,
} from "discord.js";
import type { ZodType } from "zod";
import type { GuildConfig } from "../config/schemas/guild.js";
import type { ConfigManager } from "../config/manager.js";

export type EmojiKind = "success" | "error" | "neutral";

export type ConfigOverride = {
  level?: string;
  channel?: string;
  category?: string;
  user?: string;
  config: Record<string, unknown>;
};

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

export type EventHandler = {
  name: string;
  once?: boolean;
  execute: (client: Client, ...args: unknown[]) => Promise<void>;
};

export type DreamlinerPlugin = {
  name: string;
  configSchema?: ZodType;
  defaultOverrides?: ConfigOverride[];
  dependencies?: string[];
  slashCommands: SlashCommandDefinition[];
  events?: EventHandler[];
  onLoad?: (ctx: PluginLoadContext) => Promise<void>;
};

export type PluginLoadContext = {
  client: Client;
  configManager: ConfigManager;
};

export type PluginData = {
  guildConfig: GuildConfig;
  pluginConfig: Record<string, unknown>;
  getMatchingConfig: (opts: {
    member: GuildMember;
    channelId: string;
    categoryId?: string | null;
  }) => Record<string, unknown>;
  hasPermission: (permission: string, member: GuildMember, channelId: string) => boolean;
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

export type { GuildConfig, ChatInputCommandInteraction, GuildMember, Message };
