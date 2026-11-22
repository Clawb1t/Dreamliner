import type { ZodTypeAny } from "zod";
import type { PermName } from "../../../core/actorPermissions.js";
import type { CatalogField } from "./fields.js";
import type { RunCtx } from "./runtime.js";
import type { CommandOption, Step, VarValue } from "./types.js";

export type CategoryKey = "messages" | "members" | "channels" | "roles" | "logic" | "variables" | "interactions" | "plugins" | "utilities";

export type BlockKind = "if" | "repeat" | "repeat_each" | "random_branch" | "buttons" | "select_menu" | "form" | "wait" | "stop";

export type StepOutputs = Record<string, VarValue>;
/** Outputs Dreamliner generated (mentions, ids, urls): not escaped in messages. */
export type RunResult = { outputs?: StepOutputs; trusted?: string[] } | void;

export type ValidateHelpers = {
  issue(field: string, message: string): void;
  options: CommandOption[];
  /** Steps that run before this one (in order, including enclosing blocks' earlier steps). */
  earlier: Step[];
};

export type ActionDef = {
  type: string;
  category: CategoryKey;
  label: string;
  description: string;
  icon: string;
  fields: CatalogField[];
  outputs: { key: string; label: string }[];
  defaults?: Record<string, unknown>;
  /** One sentence, {fieldKey} replaced by the field's display value on the dashboard. */
  summary: string;
  plugin?: string;
  pluginLabel?: string;
  block?: BlockKind;
  /** Nested keys of blocks (validated by the program validator). */
  extraSchema?: Record<string, ZodTypeAny>;
  /** Discord permissions the builder must hold to save it (and keep holding to run it). */
  builderPerms?: (config: Record<string, unknown>) => PermName[];
  /** Discord permissions Dreamliner needs. */
  botPerms?: (config: Record<string, unknown>) => PermName[];
  /** Moderation: permissions the person RUNNING it must hold too (checked at run time). */
  runnerPerms?: (config: Record<string, unknown>) => PermName[];
  /** Config keys holding picked roles that the step gives, takes or edits (hierarchy-checked). */
  grantRoleKeys?: string[];
  /** Creates a channel, role or thread (counted against the creation caps). */
  creates?: boolean;
  /** Extra save-time checks. */
  validate?: (config: Record<string, unknown>, v: ValidateHelpers) => void;
  run?: (ctx: RunCtx, config: Record<string, unknown>, step: Step) => Promise<RunResult>;
};

// ── Field helpers ───────────────────────────────────────────────────────────────────────────

export const userTargetField = (label = "Who", help?: string): CatalogField => ({
  key: "target",
  label,
  kind: "user_target",
  required: true,
  help: help ?? "The person who ran the command, or someone picked in an option.",
});

export const channelTargetField = (key = "channel", label = "Channel", channelTypes?: string[], help?: string): CatalogField => ({
  key,
  label,
  kind: "channel_target",
  required: true,
  channelTypes,
  help: help ?? "Pick a channel, use the channel it was used in, or a channel option.",
});

export const roleTargetField = (key = "role", label = "Role"): CatalogField => ({
  key,
  label,
  kind: "role_target",
  required: true,
  help: "Pick a role, or use a role option.",
});

export const reasonField: CatalogField = {
  key: "reason",
  label: "Reason (audit log)",
  kind: "text",
  maxLength: 400,
  variables: true,
  placeholder: "Used /{command}",
};

export const str = (config: Record<string, unknown>, key: string): string => (typeof config[key] === "string" ? (config[key] as string) : "");
export const num = (config: Record<string, unknown>, key: string, fallback = 0): number =>
  typeof config[key] === "number" && Number.isFinite(config[key]) ? (config[key] as number) : fallback;
export const bool = (config: Record<string, unknown>, key: string): boolean => config[key] === true;
export const arr = (config: Record<string, unknown>, key: string): string[] =>
  Array.isArray(config[key]) ? (config[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
