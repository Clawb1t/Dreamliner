import { definePlugin } from "../../core/plugin.js";
import { zAdminConfig } from "../../config/schemas/plugins.js";
import { adminDefaultOverrides } from "./defaultOverrides.js";
import { adminCommands } from "./commands.js";

export const adminPlugin = definePlugin({
  name: "admin",
  configSchema: zAdminConfig,
  defaultOverrides: adminDefaultOverrides,
  slashCommands: adminCommands,
});
