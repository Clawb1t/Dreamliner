import { definePlugin } from "../../core/plugin.js";
import { zLocateUserConfig } from "../../config/schemas/plugins.js";
import { locateUserDefaultOverrides } from "./defaultOverrides.js";
import { locateCommands } from "./commands/locate.js";

export const locateUserPlugin = definePlugin({
  name: "locate_user",
  configSchema: zLocateUserConfig,
  defaultOverrides: locateUserDefaultOverrides,
  slashCommands: locateCommands,
});
