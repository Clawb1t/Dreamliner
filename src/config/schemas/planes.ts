import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

// Pack price/size are deliberately NOT here: the plane card catalog and packs are global
// (bot-wide), not per-server, so they're managed only via /planesadmin (see functions/settings.ts),
// never through the per-guild dashboard config.
export const zPlanesConfig = z.strictObject({
  can_view: boolPerm("view the plane card catalog, card details, and inventories"),
  can_buy_pack: boolPerm("buy and open plane card packs"),
  can_give: boolPerm("give a plane card (1 at a time) to another member"),
});

export const zPlanesPluginSection = zPluginSection(zPlanesConfig.shape);

export type PlanesConfig = z.infer<typeof zPlanesConfig>;
