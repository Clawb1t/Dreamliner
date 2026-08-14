import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zCompanionChannelsConfig } from "../../config/schemas/companion.js";
import { companionChannelsCommands } from "./commands.js";
import {
  handleCompanionChannelDelete,
  handleCompanionReady,
  handleCompanionVoiceStateUpdate,
  syncGuildCompanion,
} from "./functions/handlers.js";

export const companionChannelsPlugin = definePlugin({
  name: "companion_channels",
  configSchema: zCompanionChannelsConfig,
  slashCommands: companionChannelsCommands,
  onLoad: async ({ client, configManager }) => {
    configManager.onSave((guildId, config) => {
      void syncGuildCompanion(client, guildId, config).catch((error) => {
        console.error(`[companion] Failed to apply companion config for ${guildId}:`, error);
      });
    });
  },
  events: [
    {
      name: Events.ClientReady,
      once: true,
      execute: async (client) => {
        await handleCompanionReady(client as import("discord.js").Client);
      },
    },
    {
      name: Events.VoiceStateUpdate,
      execute: async (_client, oldState: unknown, newState: unknown) => {
        await handleCompanionVoiceStateUpdate(
          oldState as import("discord.js").VoiceState,
          newState as import("discord.js").VoiceState,
        );
      },
    },
    {
      name: Events.ChannelDelete,
      execute: async (_client, channel: unknown) => {
        await handleCompanionChannelDelete(channel as { id: string; guild?: { id: string } | null });
      },
    },
  ],
});
