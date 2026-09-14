import { definePlugin } from "../../core/plugin.js";
import { languageCommands } from "./commands.js";

export const languagePlugin = definePlugin({
  name: "language",
  slashCommands: languageCommands,
});

export { LANGUAGE_SELECT_PREFIX } from "./constants.js";
export { handleLanguageSelectInteraction } from "./functions/select.js";
