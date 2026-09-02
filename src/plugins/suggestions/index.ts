import { definePlugin } from "../../core/plugin.js";
import { zSuggestionsConfig } from "../../config/schemas/suggestions.js";
import { suggestionsCommands } from "./commands.js";

export const suggestionsPlugin = definePlugin({
  name: "suggestions",
  configSchema: zSuggestionsConfig,
  slashCommands: suggestionsCommands,
});
