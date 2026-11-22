/**
 * Program validation: size cap, strict zod schemas (unknown keys and unknown step types are
 * rejected), per-field rules, form placement, nesting depth and step counts. Returns every issue
 * found (not just the first) with a path the dashboard maps to a field, and the normalised
 * program (missing settings filled with defaults). Templates and imports go through this too.
 */
import { z } from "zod";
import { PermissionFlagsBits } from "discord.js";
import type { ActionDef } from "./action.js";
import { CONDITION_MAP } from "./conditions.js";
import { fieldDefault, fieldMissing, fieldVisible, schemaForFields, SNOWFLAKE_RE, type CatalogField } from "./fields.js";
import { ACTION_MAP, ACTION_SCHEMAS } from "./registry.js";
import {
  LIMITS,
  OPTION_CHANNEL_TYPES,
  OPTION_TYPES,
  PROGRAM_VERSION,
  type CommandAccess,
  type CommandOption,
  type CommandProgram,
  type Condition,
  type Step,
} from "./types.js";
import { upgradeLegacyProgram } from "./legacy.js";

export type Issue = { path: string; stepId: string | null; message: string };

export const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const OPTION_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const STEP_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const SINGLE_TOKEN_RE = /^\{[a-z][a-z0-9_]{0,40}(?:\.[a-z0-9_-]{1,40}){0,4}\}$/;
const PERM_NAMES = new Set(Object.keys(PermissionFlagsBits));

export const EMPTY_ACCESS: CommandAccess = { roles: [], rolesMode: "any", blockedRoles: [], permissions: [], channels: [], blockedChannels: [], visibility: [] };

const zTop = z.strictObject({
  version: z.literal(PROGRAM_VERSION),
  description: z.string(),
  ephemeral: z.boolean(),
  options: z.array(z.unknown()).max(LIMITS.options),
  access: z.strictObject({
    roles: z.array(z.string().regex(SNOWFLAKE_RE)).max(25),
    rolesMode: z.enum(["any", "all"]),
    blockedRoles: z.array(z.string().regex(SNOWFLAKE_RE)).max(25),
    permissions: z.array(z.string()).max(40),
    channels: z.array(z.string().regex(SNOWFLAKE_RE)).max(50),
    blockedChannels: z.array(z.string().regex(SNOWFLAKE_RE)).max(50),
    visibility: z.array(z.string()).max(40),
  }),
  cooldowns: z.strictObject({
    user: z.number().int().min(0).max(LIMITS.cooldownSeconds),
    channel: z.number().int().min(0).max(LIMITS.cooldownSeconds),
    global: z.number().int().min(0).max(LIMITS.cooldownSeconds),
  }),
  limits: z.strictObject({
    perUserDaily: z.number().int().min(0).max(LIMITS.dailyLimit),
    guildDaily: z.number().int().min(0).max(LIMITS.dailyLimit),
  }),
  steps: z.array(z.unknown()).max(LIMITS.totalSteps),
});

const zOption = z.strictObject({
  name: z.string(),
  description: z.string(),
  type: z.enum(OPTION_TYPES),
  required: z.boolean(),
  minLength: z.number().int().min(0).max(6000).nullable().optional(),
  maxLength: z.number().int().min(1).max(6000).nullable().optional(),
  min: z.number().finite().nullable().optional(),
  max: z.number().finite().nullable().optional(),
  channelTypes: z.array(z.enum(OPTION_CHANNEL_TYPES)).max(7).optional(),
  choices: z.array(z.strictObject({ name: z.string().min(1).max(100), value: z.string().min(1).max(100) })).max(LIMITS.choices).optional(),
  autocomplete: z.array(z.string().min(1).max(100)).max(LIMITS.autocomplete).optional(),
});

const zStep = z.strictObject({
  id: z.string(),
  type: z.string(),
  label: z.string().max(80).optional(),
  continueOnError: z.boolean().optional(),
  disabled: z.boolean().optional(),
  config: z.record(z.unknown()),
});

function zodIssues(error: z.ZodError, prefix: string, stepId: string | null): Issue[] {
  return error.issues.slice(0, 10).map((i) => ({
    path: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
    stepId,
    message: humanZod(i),
  }));
}

function humanZod(i: z.ZodIssue): string {
  switch (i.code) {
    case "unrecognized_keys":
      return `Unknown setting: ${i.keys.join(", ")}.`;
    case "too_big":
      return i.type === "string" ? `Too long (max ${i.maximum} characters).` : i.type === "array" ? `Too many (max ${i.maximum}).` : `Must be at most ${i.maximum}.`;
    case "too_small":
      return i.type === "string" ? `Too short (min ${i.minimum} characters).` : i.type === "array" ? `Add at least ${i.minimum}.` : `Must be at least ${i.minimum}.`;
    case "invalid_type":
      return i.received === "undefined" ? "This is required." : `Expected ${i.expected}.`;
    case "invalid_enum_value":
      return "Pick one of the choices.";
    default:
      return i.message || "Invalid value.";
  }
}

/** Every nested step list of a block step, with a key naming it. */
export function childLists(step: Step): Array<{ key: string; steps: Step[] }> {
  const c = step.config as Record<string, unknown>;
  const lists: Array<{ key: string; steps: Step[] }> = [];
  const asSteps = (v: unknown): Step[] => (Array.isArray(v) ? (v as Step[]) : []);
  switch (step.type) {
    case "if":
      (Array.isArray(c.branches) ? (c.branches as { steps: unknown }[]) : []).forEach((b, i) => lists.push({ key: `b${i}`, steps: asSteps(b?.steps) }));
      lists.push({ key: "else", steps: asSteps(c.else) });
      break;
    case "repeat":
    case "repeat_each":
      lists.push({ key: "steps", steps: asSteps(c.steps) });
      break;
    case "random_branch":
      (Array.isArray(c.branches) ? (c.branches as { steps: unknown }[]) : []).forEach((b, i) => lists.push({ key: `r${i}`, steps: asSteps(b?.steps) }));
      break;
    case "buttons":
      (Array.isArray(c.buttons) ? (c.buttons as { id: string; steps: unknown }[]) : []).forEach((b) => lists.push({ key: `btn:${b?.id}`, steps: asSteps(b?.steps) }));
      break;
    case "select_menu":
      (Array.isArray(c.options) ? (c.options as { id: string; steps: unknown }[]) : []).forEach((o) => lists.push({ key: `opt:${o?.id}`, steps: asSteps(o?.steps) }));
      break;
  }
  return lists;
}

export type WalkInfo = { depth: number; parent: Step | null; listKey: string; index: number };

/** Depth-first walk over every step (blocks before their children). */
export function walkSteps(steps: Step[], visit: (step: Step, info: WalkInfo) => void, depth = 0, parent: Step | null = null, listKey = "root"): void {
  steps.forEach((step, index) => {
    visit(step, { depth, parent, listKey, index });
    for (const list of childLists(step)) walkSteps(list.steps, visit, depth + 1, step, list.key);
  });
}

/** Finds a step by id anywhere in the program. */
export function findStep(steps: Step[], id: string): Step | null {
  let found: Step | null = null;
  walkSteps(steps, (s) => {
    if (!found && s.id === id) found = s;
  });
  return found;
}

/** Resolves a nested list by block id + list key (null block = top level). */
export function resolveList(program: CommandProgram, blockId: string | null, key: string): Step[] | null {
  if (blockId === null) return program.steps;
  const block = findStep(program.steps, blockId);
  if (!block) return null;
  return childLists(block).find((l) => l.key === key)?.steps ?? null;
}

export function fillConfig(def: Pick<ActionDef, "fields" | "defaults">, config: Record<string, unknown>): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...(def.defaults ?? {}) };
  for (const field of def.fields) if (!(field.key in filled)) filled[field.key] = fieldDefault(field);
  for (const [k, v] of Object.entries(config)) filled[k] = v;
  return filled;
}

const optionRef = (value: string) => /^\{option\.([a-z0-9_-]{1,32})\.id\}$/.exec(value.trim())?.[1] ?? null;

/**
 * Which variables a target field may use. Only sources whose value is a real entity picked by
 * Discord or made by this run, never free text (a text option or {var.x} could hold any id):
 * - user: the runner, whoever pressed, a user/member option, a loop over role members, or a
 *   member output of an earlier step (random member, member info);
 * - role: a role option or a role an earlier step created;
 * - channel: the current channel, a channel option, or a channel/thread an earlier step created.
 */
function targetTokenProblem(kind: string, token: string, options: CommandOption[], earlier: Step[]): string | null {
  const opt = optionRef(token);
  if (opt) {
    const o = options.find((x) => x.name === opt);
    const want = kind === "user_target" ? ["user", "member"] : kind === "role_target" ? ["role"] : ["channel"];
    return o && want.includes(o.type) ? null : `There's no ${want.join(" or ")} option named "${opt}".`;
  }
  const step = /^\{([a-z][a-z0-9_]{0,23})\.(member|user|role|channel|thread)\.id\}$/.exec(token);
  if (step) {
    const source = earlier.find((s) => s.id === step[1]);
    const okKinds = kind === "user_target" ? ["member", "user"] : kind === "role_target" ? ["role"] : ["channel", "thread"];
    if (!source) return "That step doesn't run before this one.";
    return okKinds.includes(step[2]!) ? null : "That step's output isn't the right kind here.";
  }
  const fixed: Record<string, string[]> = {
    user_target: ["{user.id}", "{press.user.id}", "{loop.item.id}"],
    role_target: [],
    channel_target: ["{channel.id}"],
  };
  if (fixed[kind]?.includes(token)) return null;
  return kind === "user_target"
    ? "Pick who this is for: the person who ran it, someone picked in a user option, or a member from an earlier step."
    : kind === "role_target"
      ? "Pick a role, a role option, or a role an earlier step created."
      : "Pick a channel, the channel it was used in, a channel option, or a channel an earlier step created.";
}

function checkTargets(fields: CatalogField[], config: Record<string, unknown>, issue: (f: string, m: string) => void, options: CommandOption[], earlier: Step[] = []): void {
  for (const field of fields) {
    if (!fieldVisible(field, config)) continue;
    const value = config[field.key];
    if (fieldMissing(field, value)) {
      issue(field.key, field.kind === "message" ? "Write the message." : `${field.label} is required.`);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    const v = value.trim();
    if (field.kind !== "user_target" && field.kind !== "role_target" && field.kind !== "channel_target") continue;
    if (field.kind !== "user_target" && SNOWFLAKE_RE.test(v)) continue; // picked id, guild-checked separately
    if (!SINGLE_TOKEN_RE.test(v)) {
      issue(field.key, targetTokenProblem(field.kind, "", options, earlier)!);
      continue;
    }
    const problem = targetTokenProblem(field.kind, v, options, earlier);
    if (problem) issue(field.key, problem);
  }
}

function validateOptions(raw: unknown[], issues: Issue[]): CommandOption[] {
  const options: CommandOption[] = [];
  const names = new Set<string>();
  let sawOptional = false;
  raw.forEach((entry, i) => {
    const parsed = zOption.safeParse(entry);
    if (!parsed.success) {
      issues.push(...zodIssues(parsed.error, `options.${i}`, null));
      return;
    }
    const o = parsed.data as CommandOption;
    const at = (k: string, message: string) => issues.push({ path: `options.${i}.${k}`, stepId: null, message });
    if (!OPTION_NAME_RE.test(o.name)) at("name", "Use 1-32 lowercase letters, numbers, - or _.");
    if (names.has(o.name)) at("name", "Two options have this name.");
    names.add(o.name);
    if (!o.description.trim() || o.description.length > 100) at("description", "Write a description (1-100 characters).");
    if (o.required && sawOptional) at("required", "Required options must come before optional ones.");
    if (!o.required) sawOptional = true;
    if (o.choices?.length && o.autocomplete?.length) at("autocomplete", "Use either fixed choices or suggestions, not both.");
    if (o.choices?.length && !["text", "integer", "number"].includes(o.type)) at("choices", "Only text and number options can have choices.");
    if (o.autocomplete?.length && o.type !== "text") at("autocomplete", "Only text options can have suggestions.");
    if (o.choices?.length && o.type !== "text" && o.choices.some((c) => !Number.isFinite(Number(c.value)) || (o.type === "integer" && !Number.isInteger(Number(c.value))))) {
      at("choices", "Choice values must be numbers for a number option.");
    }
    if (o.min != null && o.max != null && o.min > o.max) at("max", "Max must be more than min.");
    if (o.minLength != null && o.maxLength != null && o.minLength > o.maxLength) at("maxLength", "Max length must be more than min length.");
    options.push(o);
  });
  return options;
}

export type ValidationResult = { ok: boolean; issues: Issue[]; program: CommandProgram | null };

/** Validates an untrusted program (from the dashboard, an import or a template). */
export function validateProgram(input: unknown): ValidationResult {
  const issues: Issue[] = [];
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8");
  } catch {
    return { ok: false, issues: [{ path: "", stepId: null, message: "The command couldn't be read." }], program: null };
  }
  if (bytes > LIMITS.programBytes) return { ok: false, issues: [{ path: "", stepId: null, message: `The command is too big (max ${LIMITS.programBytes / 1024} KB).` }], program: null };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, issues: [{ path: "", stepId: null, message: "The command is missing." }], program: null };

  let candidate = input as Record<string, unknown>;
  if (candidate.version === 2) candidate = upgradeLegacyProgram(candidate) as unknown as Record<string, unknown>;
  candidate = {
    ...candidate,
    options: candidate.options ?? [],
    access: { ...EMPTY_ACCESS, ...((candidate.access as object | undefined) ?? {}) },
    cooldowns: { user: 0, channel: 0, global: 0, ...((candidate.cooldowns as object | undefined) ?? {}) },
    limits: { perUserDaily: 0, guildDaily: 0, ...((candidate.limits as object | undefined) ?? {}) },
  };

  const top = zTop.safeParse(candidate);
  if (!top.success) return { ok: false, issues: zodIssues(top.error, "", null), program: null };
  const t = top.data;
  if (!t.description.trim() || t.description.length > 100) issues.push({ path: "description", stepId: null, message: "Write a description (1-100 characters)." });
  for (const key of ["permissions", "visibility"] as const) {
    const bad = t.access[key].filter((p) => !PERM_NAMES.has(p));
    if (bad.length) issues.push({ path: `access.${key}`, stepId: null, message: `Unknown permission: ${bad.join(", ")}.` });
  }

  const options = validateOptions(t.options, issues);
  const seenIds = new Set<string>();
  const earlier: Step[] = [];
  let total = 0;

  const validateList = (rawList: unknown[], depth: number, path: string, context: { firstAllowsForm: boolean }): Step[] => {
    const out: Step[] = [];
    let firstActive = true;
    rawList.forEach((rawStep, index) => {
      total += 1;
      const parsed = zStep.safeParse(rawStep);
      if (!parsed.success) {
        issues.push(...zodIssues(parsed.error, `${path}.${index}`, null));
        return;
      }
      const step = parsed.data as Step;
      const stepPath = `steps.${step.id}`;
      const issue = (field: string, message: string) => issues.push({ path: field ? `${stepPath}.config.${field}` : stepPath, stepId: step.id, message });
      if (!STEP_ID_RE.test(step.id)) issues.push({ path: `${path}.${index}.id`, stepId: null, message: "Step ids use lowercase letters, numbers and _." });
      if (seenIds.has(step.id)) issue("", "Two steps share this id.");
      seenIds.add(step.id);
      const def = ACTION_MAP.get(step.type);
      if (!def) {
        issue("", `Unknown step type "${step.type.slice(0, 40)}".`);
        return;
      }
      if (depth > LIMITS.depth) issue("", `Blocks can be nested at most ${LIMITS.depth} deep.`);

      const config = fillConfig(def, step.config);
      const schema = ACTION_SCHEMAS.get(def.type)!;
      const result = schema.safeParse(config);
      if (!result.success) {
        issues.push(...zodIssues(result.error, `${stepPath}.config`, step.id));
      }
      const clean = (result.success ? result.data : config) as Record<string, unknown>;

      checkTargets(def.fields, clean, issue, options, earlier);
      if (def.runnerPerms || def.type === "send_dm") {
        const target = typeof clean.target === "string" ? clean.target.trim() : "";
        const isOption = optionRef(target) !== null;
        const ok = def.type === "send_dm" ? isOption || target === "{user.id}" : isOption || target === "";
        if (target && !ok) issue("target", def.type === "send_dm" ? "DMs can only go to the person who ran it or someone picked in a user option." : "Moderation steps can only target someone picked in a user option.");
        if (def.runnerPerms && def.fields.some((f) => f.key === "target" && f.required) && !target) issue("target", "Pick the user option this step acts on.");
      }
      if (def.type === "form") {
        const allowed = firstActive && context.firstAllowsForm;
        if (!allowed) issue("", "A form must be the first step of the command, or the first step inside a button or menu choice.");
        const inputs = Array.isArray(clean.inputs) ? (clean.inputs as { id: string }[]) : [];
        const ids = new Set<string>();
        for (const input of inputs) {
          if (ids.has(input.id)) issue("inputs", "Two questions share an id.");
          ids.add(input.id);
        }
      }
      if (def.type === "if") {
        const branches = Array.isArray(clean.branches) ? (clean.branches as { conditions: Condition[] }[]) : [];
        branches.forEach((b, bi) => {
          if (!b.conditions.length) issues.push({ path: `${stepPath}.config.branches.${bi}.conditions`, stepId: step.id, message: "Add a condition." });
          b.conditions.forEach((c, ci) => {
            const cpath = `${stepPath}.config.branches.${bi}.conditions.${ci}`;
            const cdef = CONDITION_MAP.get(String(c.type));
            if (!cdef) {
              issues.push({ path: cpath, stepId: step.id, message: "Unknown condition." });
              return;
            }
            const filled = { ...cdef.defaults, ...c } as Record<string, unknown>;
            delete filled.type;
            delete filled.negate;
            const cres = schemaForFields(cdef.fields).safeParse(filled);
            if (!cres.success) issues.push(...zodIssues(cres.error, cpath, step.id));
            checkTargets(cdef.fields, filled, (f, m) => issues.push({ path: `${cpath}.${f}`, stepId: step.id, message: m }), options, earlier);
            if (c.negate !== undefined && typeof c.negate !== "boolean") issues.push({ path: `${cpath}.negate`, stepId: step.id, message: "Expected true or false." });
            if (cdef.type === "option_provided" && !options.some((o) => o.name === String(filled.option))) issues.push({ path: `${cpath}.option`, stepId: step.id, message: "Pick one of the command's options." });
          });
        });
      }
      if (def.type === "buttons" || def.type === "select_menu") {
        const items = (Array.isArray(clean[def.type === "buttons" ? "buttons" : "options"]) ? clean[def.type === "buttons" ? "buttons" : "options"] : []) as { id: string }[];
        const ids = new Set(items.map((i) => i.id));
        if (ids.size !== items.length) issue("", "Two buttons or choices share an id.");
      }
      def.validate?.(clean, { issue, options, earlier: [...earlier] });

      earlier.push({ ...step, config: clean });
      // Children.
      const nested: Record<string, unknown> = { ...clean };
      const lists = childLists({ ...step, config: clean });
      for (const list of lists) {
        const allowsForm = list.key.startsWith("btn:") || list.key.startsWith("opt:");
        const validated = validateList(list.steps as unknown[], depth + 1, `${stepPath}.${list.key}`, { firstAllowsForm: allowsForm });
        setChildList(nested, step.type, list.key, validated);
      }
      out.push({ id: step.id, type: step.type, ...(step.label ? { label: step.label } : {}), ...(step.continueOnError ? { continueOnError: true } : {}), ...(step.disabled ? { disabled: true } : {}), config: nested });
      if (!step.disabled) firstActive = false;
    });
    return out;
  };

  const steps = validateList(t.steps, 0, "steps", { firstAllowsForm: true });
  if (total > LIMITS.totalSteps) issues.push({ path: "steps", stepId: null, message: `A command can have at most ${LIMITS.totalSteps} steps.` });
  if (!steps.length && !issues.some((i) => i.path.startsWith("steps"))) issues.push({ path: "steps", stepId: null, message: "Add at least one step." });

  const program: CommandProgram = {
    version: PROGRAM_VERSION,
    description: t.description.trim(),
    ephemeral: t.ephemeral,
    options,
    access: t.access as CommandAccess,
    cooldowns: t.cooldowns,
    limits: t.limits,
    steps,
  };
  return { ok: issues.length === 0, issues, program };
}

function setChildList(config: Record<string, unknown>, type: string, key: string, steps: Step[]): void {
  if (key === "steps") config.steps = steps;
  else if (key === "else") config.else = steps;
  else if (key.startsWith("b") && type === "if") {
    const i = Number(key.slice(1));
    const branches = (config.branches as Record<string, unknown>[]).map((b) => ({ ...b }));
    branches[i] = { ...branches[i], steps };
    config.branches = branches;
  } else if (key.startsWith("r")) {
    const i = Number(key.slice(1));
    const branches = (config.branches as Record<string, unknown>[]).map((b) => ({ ...b }));
    branches[i] = { ...branches[i], steps };
    config.branches = branches;
  } else if (key.startsWith("btn:")) {
    config.buttons = (config.buttons as { id: string }[]).map((b) => (b.id === key.slice(4) ? { ...b, steps } : b));
  } else if (key.startsWith("opt:")) {
    config.options = (config.options as { id: string }[]).map((o) => (o.id === key.slice(4) ? { ...o, steps } : o));
  }
}

/** Command-name check shared by create and rename. */
export function commandNameProblem(name: string, reserved: Set<string>): string | null {
  if (!COMMAND_NAME_RE.test(name)) return "Use 1-32 characters: lowercase letters, numbers, - and _.";
  if (reserved.has(name)) return `/${name} is a built-in Dreamliner command.`;
  return null;
}
