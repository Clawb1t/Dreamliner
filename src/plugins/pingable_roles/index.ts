import { definePlugin } from "../../core/plugin.js";
import { zPingableRolesConfig } from "../../config/schemas/plugins.js";
import { pingableRolesDefaultOverrides } from "./defaultOverrides.js";
import { pingableRoleCommands } from "./commands/manage.js";

export const pingableRolesPlugin = definePlugin({
  name: "pingable_roles",
  configSchema: zPingableRolesConfig,
  defaultOverrides: pingableRolesDefaultOverrides,
  slashCommands: pingableRoleCommands,
});
