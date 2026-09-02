import { z } from "zod";

/** Permission toggle with editor-facing help. */
export function boolPerm(action: string) {
  return z
    .boolean()
    .default(false)
    .describe(`Allow members to ${action}.`);
}

export function channelId(help: string) {
  return z
    .string()
    .optional()
    .describe(`${help} Paste a Discord channel ID (Developer Mode → right-click channel → Copy Channel ID).`);
}

export function roleId(help: string) {
  return z
    .string()
    .optional()
    .describe(`${help} Paste a Discord role ID (Developer Mode → right-click role → Copy Role ID).`);
}

export type DreamlinerFieldMeta = {
  kind?:
    | "channel"
    | "role"
    | "user"
    | "snowflake"
    | "ms"
    | "seconds"
    | "emoji"
    | "permission"
    | "color"
    | "category";
  setup?: string;
  oneExclusive?: boolean;
};

export const SETUP_HINTS: Record<NonNullable<DreamlinerFieldMeta["kind"]>, string> = {
  channel:
    "Enable Developer Mode in Discord (User Settings → Advanced), then right-click the channel → Copy Channel ID.",
  role: "Enable Developer Mode in Discord, then right-click the role → Copy Role ID.",
  user: "Enable Developer Mode in Discord, then right-click the user → Copy User ID.",
  snowflake:
    "Use a Discord snowflake ID. Enable Developer Mode, then right-click the channel, role, or user → Copy ID.",
  ms: "Enter milliseconds. 1,000 = 1 second · 60,000 = 1 minute · 3,600,000 = 1 hour.",
  seconds: "Enter seconds. 60 = 1 minute · 3,600 = 1 hour.",
  emoji: 'Use a Unicode emoji or a custom emoji like <:name:id>. The bot must be able to use custom emojis.',
  permission: "These are base permissions. Grant them to a Dreamliner Role on the Roles page instead of enabling them here directly.",
  color: "Pick a color for embeds. Stored as a decimal integer (0–16777215).",
  category: "Enable Developer Mode in Discord, then right-click the category → Copy Channel ID.",
};

type JsonSchemaNode = {
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
  enum?: unknown[];
  "x-dreamliner"?: DreamlinerFieldMeta;
  [key: string]: unknown;
};

export function humanizeKey(key: string): string {
  if (key === "bot_roles") return "Bot Roles";
  if (key === "text_channel_id") return "No-Mic Channel";
  return key
    .replace(/^can_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isToggleKey(key: string): boolean {
  return /^(restore_|skip_|save_|allow_|ignore_|enabled)/.test(key);
}

function detectKind(key: string): DreamlinerFieldMeta["kind"] | undefined {
  if (key.startsWith("can_")) return "permission";
  if (
    !isToggleKey(key) &&
    (key === "channel_id" ||
      key.endsWith("_channel_id") ||
      key.endsWith("_channel") ||
      key === "case_log_channel" ||
      key === "ignored_channels" ||
      key === "channels")
  ) {
    return "channel";
  }
  if (
    !isToggleKey(key) &&
    (key.endsWith("_role_id") ||
      key.endsWith("_role") ||
      key.endsWith("_roles") ||
      key === "ignored_roles" ||
      key === "roles")
  ) {
    return "role";
  }
  if (
    key === "category_id" ||
    key.endsWith("_category_id") ||
    key === "category"
  ) {
    return "category";
  }
  if (key === "user" || key.endsWith("_user_id")) return "user";
  if (key.endsWith("_ms") || key === "delay_ms") return "ms";
  if (key.endsWith("_seconds") || key === "seconds") return "seconds";
  if (key.includes("emoji") || key === "success" || key === "error" || key === "neutral" || key === "warning" || key === "unchecked") {
    return "emoji";
  }
  if (key === "color" || key.endsWith("_color")) return "color";
  if (key.endsWith("_id") || key === "target_id") return "snowflake";
  return undefined;
}

export function defaultPermissionDescription(key: string): string {
  const feature = humanizeKey(key);
  return `Allow members to use ${feature}. Grant this to a Dreamliner Role instead of enabling it here directly.`;
}

/** Walk JSON Schema and attach titles, fallback help, and setup hints for the website editor. */
export function enrichJsonSchemaForEditor(schema: JsonSchemaNode, key?: string): JsonSchemaNode {
  const next: JsonSchemaNode = { ...schema };

  if (key) {
    if (!next.title) next.title = humanizeKey(key);

    const kind = detectKind(key);
    if (kind || key === "auto_translate") {
      const existing = next["x-dreamliner"] ?? {};
      next["x-dreamliner"] = {
        ...existing,
        kind: existing.kind ?? kind,
        setup: existing.setup ?? (kind ? SETUP_HINTS[kind] : undefined),
        oneExclusive: existing.oneExclusive ?? (key === "auto_translate" ? true : undefined),
      };
    }

    if (!next.description && key.startsWith("can_")) {
      next.description = defaultPermissionDescription(key);
    }
  }

  if (next.properties) {
    const props: Record<string, JsonSchemaNode> = {};
    for (const [propKey, propSchema] of Object.entries(next.properties)) {
      props[propKey] = enrichJsonSchemaForEditor(propSchema, propKey);
    }
    next.properties = props;
  }

  if (next.items) {
    if (Array.isArray(next.items)) {
      next.items = next.items.map((item) => enrichJsonSchemaForEditor(item));
    } else {
      next.items = enrichJsonSchemaForEditor(next.items);
    }
  }

  if (next.additionalProperties && typeof next.additionalProperties === "object") {
    next.additionalProperties = enrichJsonSchemaForEditor(next.additionalProperties);
  }

  return next;
}
