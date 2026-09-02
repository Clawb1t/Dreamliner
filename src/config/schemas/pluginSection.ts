import { z } from "zod";

export function zPluginSection<T extends z.ZodRawShape>(configShape: T) {
  return z.strictObject({
    enabled: z.boolean().optional().describe("Turn this plugin on or off for the server."),
    config: z.strictObject(configShape).partial().optional(),
  });
}
