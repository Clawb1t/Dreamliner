import { definePlugin } from "../../core/plugin.js";
import { zTranslationConfig } from "../../config/schemas/translation.js";
import { translationCommands } from "./commands.js";
import { autoTranslateEvents } from "./functions/autoTranslate.js";

export const translationPlugin = definePlugin({
  name: "translation",
  configSchema: zTranslationConfig,
  slashCommands: translationCommands,
  events: autoTranslateEvents,
});
