import { definePlugin } from "../../core/plugin.js";
import { zAnimeConfig } from "../../config/schemas/anime.js";
import { animeCommands } from "./commands.js";

export const animePlugin = definePlugin({
  name: "anime",
  configSchema: zAnimeConfig,
  slashCommands: animeCommands,
});
