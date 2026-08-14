import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zPersistConfig } from "../../config/schemas/plugins.js";
import {
  handlePersistChannelDelete,
  handlePersistMessageBulkDelete,
  handlePersistMessageCreate,
  handlePersistMessageDelete,
  handlePersistReady,
  syncGuildStickies,
} from "./functions/handlers.js";

export const persistPlugin = definePlugin({
  name: "persist",
  configSchema: zPersistConfig,
  slashCommands: [],
  onLoad: async ({ client, configManager }) => {
    configManager.onSave((guildId, config) => {
      void syncGuildStickies(client, guildId, { updateContent: true, guildConfig: config }).catch((error) => {
        console.error(`[persist] Failed to apply sticky config for ${guildId}:`, error);
      });
    });
  },
  events: [
    {
      name: Events.ClientReady,
      once: true,
      execute: async (client) => {
        await handlePersistReady(client as import("discord.js").Client);
      },
    },
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handlePersistMessageCreate(message as import("discord.js").Message);
      },
    },
    {
      name: Events.MessageDelete,
      execute: async (_client, message: unknown) => {
        await handlePersistMessageDelete(
          message as import("discord.js").Message | import("discord.js").PartialMessage,
        );
      },
    },
    {
      name: Events.MessageBulkDelete,
      execute: async (_client, messages: unknown, channel: unknown) => {
        await handlePersistMessageBulkDelete(
          messages as ReadonlyMap<
            string,
            import("discord.js").Message | import("discord.js").PartialMessage
          >,
          channel as import("discord.js").Message["channel"],
        );
      },
    },
    {
      name: Events.ChannelDelete,
      execute: async (_client, channel: unknown) => {
        await handlePersistChannelDelete(channel as { id: string; guild?: { id: string } | null });
      },
    },
  ],
});
