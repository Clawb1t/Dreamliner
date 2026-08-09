import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zScamProtectConfig } from "../../config/schemas/scamProtect.js";
import { scamProtectDefaultOverrides } from "./defaultOverrides.js";
import { scamProtectCommands } from "./commands.js";
import {
  handleScamProtectChannelDelete,
  handleScamProtectMessage,
  handleScamProtectReady,
} from "./functions/handlers.js";

export const scamProtectPlugin = definePlugin({
  name: "scam_protect",
  configSchema: zScamProtectConfig,
  defaultOverrides: scamProtectDefaultOverrides,
  slashCommands: scamProtectCommands,
  events: [
    {
      name: Events.ClientReady,
      once: true,
      execute: async (client) => {
        await handleScamProtectReady(client as import("discord.js").Client);
      },
    },
    {
      name: Events.GuildCreate,
      execute: async (_client, guild: unknown) => {
        const { ensureScamProtectChannel, isScamProtectEnabled } = await import("./functions/ensure.js");
        const { configManager } = await import("../../config/manager.js");
        const g = guild as import("discord.js").Guild;
        const stored = await configManager.getGuildConfig(g.id);
        if (!stored || !isScamProtectEnabled(stored)) return;
        await ensureScamProtectChannel(g).catch(() => null);
      },
    },
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleScamProtectMessage(message as import("discord.js").Message);
      },
    },
    {
      name: Events.ChannelDelete,
      execute: async (_client, channel: unknown) => {
        await handleScamProtectChannelDelete(channel as import("discord.js").Channel);
      },
    },
  ],
});
