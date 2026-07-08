import { definePlugin } from "../../core/plugin.js";
import { zSlowmodeConfig } from "../../config/schemas/plugins.js";
import { slowmodeDefaultOverrides } from "./defaultOverrides.js";
import { slowmodeCommands } from "./commands.js";

export const slowmodePlugin = definePlugin({
  name: "slowmode",
  configSchema: zSlowmodeConfig,
  defaultOverrides: slowmodeDefaultOverrides,
  slashCommands: slowmodeCommands,
});
