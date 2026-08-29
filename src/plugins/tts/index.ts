import { definePlugin } from "../../core/plugin.js";
import { zTtsConfig } from "../../config/schemas/tts.js";
import { ttsDefaultOverrides } from "./defaultOverrides.js";
import { ttsCommands } from "./commands.js";

export const ttsPlugin = definePlugin({
  name: "tts",
  configSchema: zTtsConfig,
  defaultOverrides: ttsDefaultOverrides,
  slashCommands: ttsCommands,
});
