/**
 * Step and condition settings are described once, as fields. The same list drives the
 * dashboard's form, the strict zod schema a saved config must pass (unknown keys are rejected),
 * and default values.
 */
import { z } from "zod";
import { PermissionFlagsBits } from "discord.js";
import { LIMITS } from "./types.js";

export type FieldKind =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "color"
  | "role"
  | "roles"
  | "channel"
  | "channels"
  | "user_target"
  | "role_target"
  | "channel_target"
  | "message"
  | "permissions"
  | "list"
  | "emoji";

export type CatalogField = {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  /** number: whole numbers only */
  integer?: boolean;
  maxLength?: number;
  options?: { value: string; label: string }[];
  channelTypes?: string[];
  allowCategories?: boolean;
  variables?: boolean;
  showIf?: { key: string; in: unknown[] };
  /** list: most items */
  maxItems?: number;
  /** select whose choices come from this server (tags, quizzes, ticket panels), filled in per guild
   *  by the catalog and checked at run time. */
  dynamic?: boolean;
};

export const SNOWFLAKE_RE = /^\d{15,22}$/;
export const PERMISSION_NAMES = Object.keys(PermissionFlagsBits) as (keyof typeof PermissionFlagsBits)[];

const zSnowflakeOrEmpty = z.string().max(22).refine((v) => v === "" || SNOWFLAKE_RE.test(v), "Pick from the list");
/** A picked id, or a single {variable} (checked at run time against this server only). */
const zTarget = z.string().max(120);

export const zEmbedSpec = z.strictObject({
  authorName: z.string().max(256),
  authorIconUrl: z.string().max(1000),
  authorUrl: z.string().max(1000),
  title: z.string().max(256),
  titleUrl: z.string().max(1000),
  description: z.string().max(4096),
  thumbnailUrl: z.string().max(1000),
  imageUrl: z.string().max(1000),
  color: z.number().int().min(0).max(0xffffff).nullable(),
  footerText: z.string().max(2048),
  timestamp: z.boolean(),
  fields: z
    .array(z.strictObject({ name: z.string().max(256), value: z.string().max(1024), inline: z.boolean() }))
    .max(25),
});

export const zContainerSpec = z.strictObject({
  accentColor: z.number().int().min(0).max(0xffffff).nullable(),
  title: z.string().max(256),
  body: z.string().max(4000),
  thumbnailUrl: z.string().max(1000),
  imageUrl: z.string().max(1000),
  footer: z.string().max(500),
});

export const zMessageSpec = z.strictObject({
  format: z.enum(["text", "embed", "container"]),
  content: z.string().max(LIMITS.textLength),
  variants: z.array(z.string().max(LIMITS.textLength)).max(LIMITS.variants),
  embed: zEmbedSpec,
  container: zContainerSpec,
  pings: z.strictObject({
    runner: z.boolean(),
    optionUsers: z.boolean(),
    roles: z.array(z.string().regex(SNOWFLAKE_RE)).max(10),
    everyone: z.boolean(),
  }),
});

export const EMPTY_EMBED_SPEC = {
  authorName: "",
  authorIconUrl: "",
  authorUrl: "",
  title: "",
  titleUrl: "",
  description: "",
  thumbnailUrl: "",
  imageUrl: "",
  color: null,
  footerText: "",
  timestamp: false,
  fields: [],
};

export function emptyMessageSpec(content = ""): z.infer<typeof zMessageSpec> {
  return {
    format: "text",
    content,
    variants: [],
    embed: { ...EMPTY_EMBED_SPEC, fields: [] },
    container: { accentColor: null, title: "", body: "", thumbnailUrl: "", imageUrl: "", footer: "" },
    pings: { runner: false, optionUsers: false, roles: [], everyone: false },
  };
}

/** Fills missing keys of a (possibly older) message spec so it parses. */
export function completeMessageSpec(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const base = emptyMessageSpec();
  const m = input as Record<string, unknown>;
  return {
    ...base,
    ...m,
    embed: { ...base.embed, ...((m.embed as object | undefined) ?? {}) },
    container: { ...base.container, ...((m.container as object | undefined) ?? {}) },
    pings: { ...base.pings, ...((m.pings as object | undefined) ?? {}) },
  };
}

function fieldSchema(field: CatalogField): z.ZodTypeAny {
  switch (field.kind) {
    case "text":
      return z.string().max(field.maxLength ?? 500);
    case "textarea":
      return z.string().max(field.maxLength ?? LIMITS.textLength);
    case "number": {
      let s = z.number().finite();
      if (field.integer) s = s.int();
      if (field.min !== undefined) s = s.min(field.min);
      if (field.max !== undefined) s = s.max(field.max);
      return s;
    }
    case "boolean":
      return z.boolean();
    case "select": {
      if (field.dynamic) return z.string().max(100);
      const values = (field.options ?? []).map((o) => o.value);
      return z.string().refine((v) => values.includes(v), "Pick one of the choices");
    }
    case "color":
      return z.number().int().min(0).max(0xffffff).nullable();
    case "role":
    case "channel":
      return zSnowflakeOrEmpty;
    case "roles":
    case "channels":
      return z.array(z.string().regex(SNOWFLAKE_RE)).max(field.maxItems ?? 25);
    case "user_target":
    case "role_target":
    case "channel_target":
      return zTarget;
    case "message":
      return z.preprocess(completeMessageSpec, zMessageSpec);
    case "permissions":
      return z.array(z.enum(PERMISSION_NAMES as [string, ...string[]])).max(60);
    case "list":
      return z.array(z.string().max(field.maxLength ?? 200)).max(field.maxItems ?? 50);
    case "emoji":
      return z.string().max(100);
  }
}

/** A default value for a field kind when the action doesn't give one. */
export function fieldDefault(field: CatalogField): unknown {
  switch (field.kind) {
    case "number":
      return field.min ?? 0;
    case "boolean":
      return false;
    case "select":
      return field.options?.[0]?.value ?? "";
    case "color":
      return null;
    case "roles":
    case "channels":
    case "permissions":
    case "list":
      return [];
    case "message":
      return emptyMessageSpec();
    default:
      return "";
  }
}

/** Strict object schema for a list of fields plus any extra (nested) keys. */
export function schemaForFields(fields: CatalogField[], extra: Record<string, z.ZodTypeAny> = {}): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) shape[field.key] = fieldSchema(field);
  return z.strictObject({ ...shape, ...extra });
}

/** Whether a field is visible for this config (showIf). */
export function fieldVisible(field: CatalogField, config: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  return field.showIf.in.includes(config[field.showIf.key]);
}

/** True when a required field has no value. */
export function fieldMissing(field: CatalogField, value: unknown): boolean {
  if (!field.required) return false;
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
