import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { LANGUAGE_CODES } from "../../core/languages.js";
import { zPluginSection } from "./pluginSection.js";

export const zTranslationConfig = z.strictObject({
  auto_translate: z
    .boolean()
    .default(false)
    .describe(
      "Dreamliner One exclusive. When true, react with the server default-language flag on messages that are not in that language. Members can press the reaction for a translation reply.",
    ),
  ignored_channels: z
    .array(z.string())
    .default([])
    .describe("Channel IDs where auto-translate reactions are skipped."),
  can_translate: boolPerm("use /translate"),
});

export const zTranslationPluginSection = zPluginSection(zTranslationConfig.shape);

export const zDefaultLanguage = z
  .enum(LANGUAGE_CODES)
  .default("en")
  .describe("Server default language used by /translate and auto-translate.");

export type TranslationConfig = z.infer<typeof zTranslationConfig>;
