import { definePlugin } from "../../core/plugin.js";
import { zSelfGrantableRolesConfig } from "../../config/schemas/plugins.js";
import { selfRoleCommands } from "./commands/configure.js";

export const selfGrantableRolesPlugin = definePlugin({
  name: "self_grantable_roles",
  configSchema: zSelfGrantableRolesConfig,
  slashCommands: selfRoleCommands,
});

export { handleSelfRoleButtonInteraction, handleSelfRoleSelectInteraction } from "./functions/handlers.js";
export { SELF_ROLE_PREFIX } from "./customIds.js";
