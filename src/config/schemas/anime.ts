import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

export const zAnimeConfig = z.strictObject({
  can_neko: boolPerm("fetch a random neko image with /anime neko"),
  can_saved: boolPerm("browse saved neko images with /anime saved"),
});

export const zAnimePluginSection = zPluginSection(zAnimeConfig.shape);

export type AnimeConfig = z.infer<typeof zAnimeConfig>;
