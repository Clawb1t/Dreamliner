import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zSlowmodeConfig } from "../../config/schemas/plugins.js";
import { slowmodeDefaultOverrides } from "./defaultOverrides.js";
import { slowmodeCommands } from "./commands.js";
import { handleSlowmodeMessage } from "./functions/handlers.js";
import { startSlowmodeMarkerSweeper } from "./functions/markers.js";

export const slowmodePlugin = definePlugin({
  name: "slowmode",
  configSchema: zSlowmodeConfig,
  defaultOverrides: slowmodeDefaultOverrides,
  slashCommands: slowmodeCommands,
  onLoad: async ({ client }) => {
    startSlowmodeMarkerSweeper(client);
  },
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await handleSlowmodeMessage(message as import("discord.js").Message);
      },
    },
  ],
});
