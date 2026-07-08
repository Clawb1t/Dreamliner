import { definePlugin } from "../../core/plugin.js";
import { zRoleButtonsConfig } from "../../config/schemas/plugins.js";
import { roleButtonsDefaultOverrides } from "./defaultOverrides.js";
import { roleButtonCommands } from "./commands/manage.js";

export const roleButtonsPlugin = definePlugin({
  name: "role_buttons",
  configSchema: zRoleButtonsConfig,
  defaultOverrides: roleButtonsDefaultOverrides,
  slashCommands: roleButtonCommands,
});

export { handleRoleButtonInteraction } from "./functions/handlers.js";
export { ROLE_BUTTON_PREFIX } from "./defaultOverrides.js";
