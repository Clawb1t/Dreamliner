import { definePlugin } from "../../core/plugin.js";
import { zTagsConfig } from "../../config/schemas/plugins.js";
import { tagsDefaultOverrides } from "./defaultOverrides.js";
import { tagsCommands } from "./commands.js";

export const tagsPlugin = definePlugin({
  name: "tags",
  configSchema: zTagsConfig,
  defaultOverrides: tagsDefaultOverrides,
  slashCommands: tagsCommands,
});
