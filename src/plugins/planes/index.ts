import { definePlugin } from "../../core/plugin.js";
import { zPlanesConfig } from "../../config/schemas/planes.js";
import { planesDefaultOverrides } from "./defaultOverrides.js";
import { planesCommands } from "./commands.js";

export const planesPlugin = definePlugin({
  name: "planes",
  configSchema: zPlanesConfig,
  defaultOverrides: planesDefaultOverrides,
  slashCommands: planesCommands,
});

export { handlePlanesAutocomplete } from "./commands.js";
export {
  handlePlaneStatsButtonInteraction,
  PLANE_STATS_PREFIX,
  handlePlanePackButtonInteraction,
  PLANE_PACK_PREFIX,
  handlePlaneInventoryButtonInteraction,
  PLANE_INVENTORY_PREFIX,
} from "./functions/buttons.js";
