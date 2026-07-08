import { definePlugin } from "../../core/plugin.js";
import { zSelfGrantableRolesConfig } from "../../config/schemas/plugins.js";
import { selfGrantableRolesDefaultOverrides } from "./defaultOverrides.js";
import { selfRoleCommands } from "./commands/configure.js";

export const selfGrantableRolesPlugin = definePlugin({
  name: "self_grantable_roles",
  configSchema: zSelfGrantableRolesConfig,
  defaultOverrides: selfGrantableRolesDefaultOverrides,
  slashCommands: selfRoleCommands,
});

export { handleSelfRoleButtonInteraction, handleSelfRoleSelectInteraction } from "./functions/handlers.js";
export { SELF_ROLE_PREFIX } from "./defaultOverrides.js";
