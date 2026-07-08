import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zCompanionChannelsConfig } from "../../config/schemas/plugins.js";
import { companionChannelsDefaultOverrides } from "./defaultOverrides.js";
import { companionChannelsCommands } from "./commands.js";
import { handleCompanionVoiceStateUpdate } from "./functions/handlers.js";

export const companionChannelsPlugin = definePlugin({
  name: "companion_channels",
  configSchema: zCompanionChannelsConfig,
  defaultOverrides: companionChannelsDefaultOverrides,
  slashCommands: companionChannelsCommands,
  events: [
    {
      name: Events.VoiceStateUpdate,
      execute: async (_client, oldState: unknown, newState: unknown) => {
        await handleCompanionVoiceStateUpdate(
          oldState as import("discord.js").VoiceState,
          newState as import("discord.js").VoiceState,
        );
      },
    },
  ],
});
