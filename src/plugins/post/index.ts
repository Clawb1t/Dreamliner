import { definePlugin } from "../../core/plugin.js";
import { zPostConfig } from "../../config/schemas/plugins.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { postDefaultOverrides } from "./defaultOverrides.js";
import { postCommands } from "./commands.js";
import { processDuePosts } from "./functions/scheduler.js";

export const postPlugin = definePlugin({
  name: "post",
  configSchema: zPostConfig,
  defaultOverrides: postDefaultOverrides,
  slashCommands: postCommands,
  onLoad: async () => {
    registerIntervalTask({
      id: "post:due",
      intervalMs: 60_000,
      run: processDuePosts,
    });
  },
});
