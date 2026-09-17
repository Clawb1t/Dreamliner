import { definePlugin } from "../../core/plugin.js";
import { zMusicConfig } from "../../config/schemas/music.js";
import { musicCommands } from "./commands/index.js";
import { initLavalinkManager } from "./functions/manager.js";

export const musicPlugin = definePlugin({
  name: "music",
  configSchema: zMusicConfig,
  slashCommands: musicCommands,
  onLoad: async ({ client }) => {
    initLavalinkManager(client);
  },
});
