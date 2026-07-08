import { z } from "zod";

export const zPluginOverride = z.strictObject({
  level: z.string().optional(),
  channel: z.string().optional(),
  category: z.string().optional(),
  user: z.string().optional(),
  config: z.record(z.unknown()),
});

export function zPluginSection<T extends z.ZodRawShape>(configShape: T) {
  return z.strictObject({
    enabled: z.boolean().optional(),
    config: z.strictObject(configShape).partial().optional(),
    overrides: z.array(zPluginOverride).optional(),
    replaceDefaultOverrides: z.boolean().optional(),
  });
}

export type PluginOverride = z.infer<typeof zPluginOverride>;
