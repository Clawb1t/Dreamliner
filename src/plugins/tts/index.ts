import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zTtsConfig } from "../../config/schemas/tts.js";
import { ttsDefaultOverrides } from "./defaultOverrides.js";
import { ttsCommands } from "./commands.js";
import { handleTtsTextChannelMessage } from "./functions/textChannel.js";
import { syncTtsChannelTopic } from "./functions/channelTopic.js";

export const ttsPlugin = definePlugin({
  name: "tts",
  configSchema: zTtsConfig,
  defaultOverrides: ttsDefaultOverrides,
  slashCommands: ttsCommands,
  onLoad: async ({ client, configManager }) => {
    configManager.onSave((guildId, config) => {
      void syncTtsChannelTopic(client, guildId, config).catch((error) => {
        console.error(`[tts] Failed to sync channel topic for ${guildId}:`, error);
      });
    });
  },
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleTtsTextChannelMessage(message as import("discord.js").Message);
      },
    },
  ],
});
