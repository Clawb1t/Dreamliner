import { z } from "zod";

/**
 * Builds a plugin's `{ enabled, config }` section schema. `enabledByDefault` is baked in here
 * (rather than left to `pluginEnabled()`'s "undefined means enabled" runtime check) so that
 * `zGuildConfig.parse({})` alone produces a complete, correct default config — no separate
 * default-config file needed. `config`'s own default is computed by parsing `{}` through the
 * *non-partial* config schema first: a `.partial()` schema's own per-field `.default()`s don't
 * apply when the field is simply absent (zod's `ZodOptional` — which `.partial()` wraps every
 * field in — short-circuits to `undefined` before ever reaching the inner `ZodDefault`), so
 * without this, a bare `{}` would produce an empty `config: {}` instead of one filled with every
 * field's real default.
 */
export function zPluginSection<T extends z.ZodRawShape>(configShape: T, enabledByDefault = false) {
  const fullConfigSchema = z.strictObject(configShape);
  return z.strictObject({
    enabled: z.boolean().default(enabledByDefault).describe("Turn this plugin on or off for the server."),
    config: fullConfigSchema.partial().default(() => fullConfigSchema.parse({})),
  });
}
