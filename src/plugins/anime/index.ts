import { definePlugin } from "../../core/plugin.js";
import { zAnimeConfig } from "../../config/schemas/anime.js";
import { animeDefaultOverrides } from "./defaultOverrides.js";
import { animeCommands } from "./commands.js";

export const animePlugin = definePlugin({
  name: "anime",
  configSchema: zAnimeConfig,
  defaultOverrides: animeDefaultOverrides,
  slashCommands: animeCommands,
});
