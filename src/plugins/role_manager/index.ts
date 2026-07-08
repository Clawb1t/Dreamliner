import { definePlugin } from "../../core/plugin.js";
import { zRoleManagerConfig } from "../../config/schemas/plugins.js";
import { roleManagerDefaultOverrides } from "./defaultOverrides.js";
import { roleManagerCommands } from "./commands/manage.js";

export const roleManagerPlugin = definePlugin({
  name: "role_manager",
  configSchema: zRoleManagerConfig,
  defaultOverrides: roleManagerDefaultOverrides,
  slashCommands: roleManagerCommands,
});
