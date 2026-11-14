import { definePlugin } from "../../core/plugin.js";
import { zMusicConfig } from "../../config/schemas/music.js";
import { musicCommands } from "./commands/index.js";
import { initLavalinkManager } from "./functions/manager.js";
import { getLogger } from "../../core/logger.js";
import { loadRadioClocks } from "./radio/clock.js";
import { refreshKeptRadioAssets } from "./radio/store.js";

const log = getLogger("music");

export const musicPlugin = definePlugin({
  name: "music",
  configSchema: zMusicConfig,
  slashCommands: musicCommands,
  onLoad: async ({ client }) => {
    // Station clocks load before Lavalink connects, so resumed sessions can re-tune to them.
    await loadRadioClocks().catch((error: unknown) => log.error("Failed to load radio station clocks:", error));
    await refreshKeptRadioAssets().catch(() => {});
    initLavalinkManager(client);
  },
});
