import { definePlugin } from "../../core/plugin.js";
import { zSuggestionsConfig } from "../../config/schemas/suggestions.js";
import { suggestionsDefaultOverrides } from "./defaultOverrides.js";
import { suggestionsCommands } from "./commands.js";

export const suggestionsPlugin = definePlugin({
  name: "suggestions",
  configSchema: zSuggestionsConfig,
  defaultOverrides: suggestionsDefaultOverrides,
  slashCommands: suggestionsCommands,
});
