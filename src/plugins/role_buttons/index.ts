import { definePlugin } from "../../core/plugin.js";
import { zRoleButtonsConfig } from "../../config/schemas/plugins.js";
import { roleButtonsDefaultOverrides } from "./defaultOverrides.js";

/**
 * Legacy — superseded by the `role_panels` plugin's dashboard editor. `/rolebutton` is removed
 * (slashCommands: [], see src/plugins/bot_customisation/ for the same zero-command precedent);
 * this plugin stays registered only so panels created before the change keep working.
 */
export const roleButtonsPlugin = definePlugin({
  name: "role_buttons",
  configSchema: zRoleButtonsConfig,
  defaultOverrides: roleButtonsDefaultOverrides,
  slashCommands: [],
});

export { handleRoleButtonInteraction } from "./functions/handlers.js";
export { ROLE_BUTTON_PREFIX } from "./defaultOverrides.js";
