import { definePlugin } from "../../core/plugin.js";
import { zBotCustomisationConfig } from "../../config/schemas/plugins.js";

export { BOT_AVATAR_PREFIX } from "./constants.js";
export { handleBotAvatarButtonInteraction } from "./functions/handlers.js";

/** Per-server bot brand (avatar, banner, nick, bio) — managed from the web dashboard. */
export const botCustomisationPlugin = definePlugin({
  name: "bot_customisation",
  configSchema: zBotCustomisationConfig,
  slashCommands: [],
});
