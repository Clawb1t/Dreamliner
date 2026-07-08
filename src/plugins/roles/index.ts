import { definePlugin } from "../../core/plugin.js";
import { zRolesConfig } from "../../config/schemas/plugins.js";
import { rolesDefaultOverrides } from "./defaultOverrides.js";
import { rolesCommands } from "./commands/manage.js";

export const rolesPlugin = definePlugin({
  name: "roles",
  configSchema: zRolesConfig,
  defaultOverrides: rolesDefaultOverrides,
  slashCommands: rolesCommands,
});
