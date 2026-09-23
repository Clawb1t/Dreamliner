import { definePlugin } from "../../core/plugin.js";
import { zImagesConfig } from "../../config/schemas/images.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { imagesCommands } from "./commands.js";
import { runDailyImageSends } from "./functions/daily.js";

export const imagesPlugin = definePlugin({
  name: "images",
  configSchema: zImagesConfig,
  slashCommands: imagesCommands,
  onLoad: async () => {
    // Daily sends are set to a minute of the day, so check once a minute.
    registerIntervalTask({
      id: "images:daily-sends",
      intervalMs: 60_000,
      run: runDailyImageSends,
    });
  },
});
