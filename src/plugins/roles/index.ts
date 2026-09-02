import { definePlugin } from "../../core/plugin.js";
import { zRolesConfig } from "../../config/schemas/plugins.js";
import { rolesCommands } from "./commands/manage.js";

export const rolesPlugin = definePlugin({
  name: "roles",
  configSchema: zRolesConfig,
  slashCommands: rolesCommands,
});
