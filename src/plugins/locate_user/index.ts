import { definePlugin } from "../../core/plugin.js";
import { zLocateUserConfig } from "../../config/schemas/plugins.js";
import { locateCommands } from "./commands/locate.js";
import { seenCommands } from "./commands/seen.js";

export const locateUserPlugin = definePlugin({
  name: "locate_user",
  configSchema: zLocateUserConfig,
  slashCommands: [...locateCommands, ...seenCommands],
});
