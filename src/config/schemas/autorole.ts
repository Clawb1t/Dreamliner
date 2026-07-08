import { z } from "zod";

const pluginOverrideSchema = z.strictObject({
  level: z.string().optional(),
  channel: z.string().optional(),
  category: z.string().optional(),
  user: z.string().optional(),
  config: z.record(z.unknown()),
});

export const zAutoroleRoleEntry = z.strictObject({
  role: z.string(),
  delay_ms: z.number().int().min(0).default(0),
  delay: z.string().optional(),
});

export const zAutoroleConfig = z.strictObject({
  /** Role IDs or entries with per-role delay. */
  roles: z.array(z.union([z.string(), zAutoroleRoleEntry])).default([]),
});

export const zAutorolePluginSection = z.strictObject({
  enabled: z.boolean().optional(),
  config: zAutoroleConfig.partial().optional(),
  overrides: z.array(pluginOverrideSchema).optional(),
  replaceDefaultOverrides: z.boolean().optional(),
});

export type AutoroleConfig = z.infer<typeof zAutoroleConfig>;
export type AutoroleRoleEntry = z.infer<typeof zAutoroleRoleEntry>;

export type NormalizedAutoroleEntry = {
  roleId: string;
  delayMs: number;
};
