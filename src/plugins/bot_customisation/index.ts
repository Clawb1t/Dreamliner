import { definePlugin } from "../../core/plugin.js";
import { zBotCustomisationConfig } from "../../config/schemas/plugins.js";
import { botCustomisationDefaultOverrides } from "./defaultOverrides.js";
import { botCommands } from "./commands/bot.js";

export { BOT_AVATAR_PREFIX } from "./constants.js";
export { handleBotAvatarButtonInteraction } from "./functions/handlers.js";

export const botCustomisationPlugin = definePlugin({
  name: "bot_customisation",
  configSchema: zBotCustomisationConfig,
  defaultOverrides: botCustomisationDefaultOverrides,
  slashCommands: botCommands,
});
