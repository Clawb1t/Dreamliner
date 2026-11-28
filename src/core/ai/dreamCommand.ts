/**
 * Autopilot for Custom Commands: turns a plain-language description into a complete v3 command
 * program (name, description, options, access, cooldowns and steps, blocks included), and refines
 * an existing draft ("make it ephemeral", "add a cooldown") in the same conversation.
 *
 * Output shape. The model answers through OpenAI strict structured output. Everything with a fixed
 * shape is typed in the schema (options, access, cooldowns, limits, and each step's id and type,
 * the type limited to steps this builder may use). A step's own settings travel as `config_json`
 * (a JSON string) because the 60-odd step types each have their own settings; nested step lists
 * (If branches, Repeat, Buttons, Menu choices...) are typed `children` so nesting stays structural.
 * The engine's own validator (validateProgram), guild id check and builder-permission check are
 * then run on the assembled program, so nothing the model writes is trusted.
 *
 * This module is pure (no OpenAI call, no database): the gated runner lives in bridge/webAi.ts.
 */
import { PermissionFlagsBits, type Guild } from "discord.js";
import { missingActorPermissions, type ActorInfo, type PermName } from "../actorPermissions.js";
import { VARIABLE_DOCS } from "../../plugins/dream_commands/engine/catalog.js";
import { CONDITIONS } from "../../plugins/dream_commands/engine/conditions.js";
import type { CatalogField } from "../../plugins/dream_commands/engine/fields.js";
import { builderReport, checkGuildIds, collectRequirements } from "../../plugins/dream_commands/engine/permissions.js";
import { ACTIONS, ACTION_MAP } from "../../plugins/dream_commands/engine/registry.js";
import {
  LIMITS,
  OPTION_CHANNEL_TYPES,
  OPTION_TYPES,
  PROGRAM_VERSION,
  type CommandProgram,
  type Step,
} from "../../plugins/dream_commands/engine/types.js";
import { childLists, commandNameProblem, fillConfig, validateProgram, type Issue } from "../../plugins/dream_commands/engine/validate.js";
import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  bool,
  entityList,
  int,
  nullable,
  num,
  obj,
  oneOf,
  progressInstruction,
  str,
  turnSchema,
  type AiWizardContext,
} from "./wizardKit.js";

export const DREAM_COMMAND_WIZARD_ID = "dream_command";
/** Clarifying questions before Autopilot must build (it usually builds straight away). */
export const DREAM_COMMAND_MAX_QUESTIONS = 3;
/** Output budget: a full program with several steps and messages is long. */
export const DREAM_COMMAND_MAX_TOKENS = 7000;

const PERM_NAMES = Object.keys(PermissionFlagsBits) as PermName[];
/** OpenAI strict mode allows about 1000 enum values in a schema; ids get what's left after the
 * fixed enums (step types, permissions, option and channel types). */
const ID_ENUM_BUDGET = 600;

// ── Which steps this builder may use ────────────────────────────────────────────────────────

/**
 * Step types the requesting member could save: the step's plugin is on, and they hold every
 * permission the step needs with its default settings (the same rule as the builder's catalog).
 * Settings that need more (pinging roles needs Mention Everyone) are caught by builderReport.
 */
export function allowedActionTypes(guildConfig: { plugins: Record<string, { enabled?: boolean } | undefined> }, actor: ActorInfo): string[] {
  return ACTIONS.filter((def) => {
    if (def.plugin && guildConfig.plugins[def.plugin]?.enabled === false) return false;
    const perms = (def.builderPerms?.(fillConfig(def, {})) ?? []) as PermName[];
    return missingActorPermissions(actor, perms).length === 0;
  }).map((def) => def.type);
}

// ── Schema ──────────────────────────────────────────────────────────────────────────────────

function idEnum(ids: string[], budget: { left: number }): Record<string, unknown> {
  if (ids.length && ids.length <= budget.left) {
    budget.left -= ids.length;
    return { type: "string", enum: ids };
  }
  return { type: "string" };
}

/** The whole turn schema: ask a question, or hand back a full command (the "config"). */
export function buildDreamCommandSchema(ctx: AiWizardContext, allowedTypes: string[]): Record<string, unknown> {
  const budget = { left: ID_ENUM_BUDGET };
  const roleId = idEnum(ctx.roles.map((r) => r.id), budget);
  const channelIds = [...ctx.textChannels, ...ctx.voiceChannels, ...ctx.categories].map((c) => c.id);
  const channelId = idEnum(channelIds, budget);

  const option = obj({
    name: str(),
    description: str(),
    type: oneOf(OPTION_TYPES),
    required: bool(),
    minLength: nullable(int()),
    maxLength: nullable(int()),
    min: nullable(num()),
    max: nullable(num()),
    channelTypes: nullable({ type: "array", items: oneOf(OPTION_CHANNEL_TYPES) }),
    choices: nullable({ type: "array", items: obj({ name: str(), value: str() }) }),
    autocomplete: nullable({ type: "array", items: str() }),
  });
  const permArray = { type: "array", items: { $ref: "#/$defs/perm_name" } };
  const command = obj({
    name: str(),
    description: str(),
    ephemeral: bool(),
    options: { type: "array", items: option },
    access: obj({
      roles: { type: "array", items: { $ref: "#/$defs/role_id" } },
      rolesMode: oneOf(["any", "all"]),
      blockedRoles: { type: "array", items: { $ref: "#/$defs/role_id" } },
      permissions: permArray,
      channels: { type: "array", items: { $ref: "#/$defs/channel_id" } },
      blockedChannels: { type: "array", items: { $ref: "#/$defs/channel_id" } },
      visibility: permArray,
    }),
    cooldowns: obj({ user: int(), channel: int(), global: int() }),
    limits: obj({ perUserDaily: int(), guildDaily: int() }),
    steps: { type: "array", items: { $ref: "#/$defs/step" } },
  });
  const step = obj({
    id: str(),
    type: { type: "string", enum: allowedTypes.length ? allowedTypes : ["reply"] },
    label: nullable(str()),
    continueOnError: bool(),
    config_json: str(),
    children: { type: "array", items: obj({ list: str(), steps: { type: "array", items: { $ref: "#/$defs/step" } } }) },
  });
  return {
    ...turnSchema(command),
    $defs: { step, role_id: roleId, channel_id: channelId, perm_name: { type: "string", enum: PERM_NAMES } },
  };
}

// ── The model's step envelope <-> engine steps ──────────────────────────────────────────────

export type EnvelopeStep = {
  id: string;
  type: string;
  label: string | null;
  continueOnError: boolean;
  config_json: string;
  children: { list: string; steps: EnvelopeStep[] }[];
};

const NESTED_KEYS: Record<string, string[]> = {
  if: ["else"],
  repeat: ["steps"],
  repeat_each: ["steps"],
};

/** A step config without its nested step lists (they travel as children). */
function flatConfig(step: Step): Record<string, unknown> {
  const config = { ...step.config };
  for (const key of NESTED_KEYS[step.type] ?? []) config[key] = [];
  const stripSteps = (list: unknown) => (Array.isArray(list) ? list.map((item) => (item && typeof item === "object" ? { ...(item as object), steps: [] } : item)) : list);
  if (step.type === "if" || step.type === "random_branch") config.branches = stripSteps(config.branches);
  if (step.type === "buttons") config.buttons = stripSteps(config.buttons);
  if (step.type === "select_menu") config.options = stripSteps(config.options);
  return config;
}

/** Engine steps as the model's envelope (used to show it a draft it's refining). */
export function toEnvelope(steps: Step[]): EnvelopeStep[] {
  return steps.map((step) => ({
    id: step.id,
    type: step.type,
    label: step.label ?? null,
    continueOnError: step.continueOnError === true,
    config_json: JSON.stringify(flatConfig(step)),
    children: childLists(step)
      .filter((list) => list.steps.length > 0)
      .map((list) => ({ list: list.key, steps: toEnvelope(list.steps) })),
  }));
}

function attachChild(type: string, config: Record<string, unknown>, list: string, steps: Step[]): boolean {
  if ((type === "repeat" || type === "repeat_each") && list === "steps") {
    config.steps = steps;
    return true;
  }
  if (type === "if" && list === "else") {
    config.else = steps;
    return true;
  }
  const indexed = /^([br])(\d{1,2})$/.exec(list);
  if (indexed && ((type === "if" && indexed[1] === "b") || (type === "random_branch" && indexed[1] === "r"))) {
    const i = Number(indexed[2]);
    if (i >= LIMITS.branches) return false;
    const branches = Array.isArray(config.branches) ? [...(config.branches as Record<string, unknown>[])] : [];
    while (branches.length <= i) branches.push(type === "if" ? { match: "all", conditions: [], steps: [] } : { weight: 1, steps: [] });
    branches[i] = { ...branches[i], steps };
    config.branches = branches;
    return true;
  }
  const keyed = /^(btn|opt):([a-z0-9]{1,8})$/.exec(list);
  if (keyed && ((type === "buttons" && keyed[1] === "btn") || (type === "select_menu" && keyed[1] === "opt"))) {
    const field = type === "buttons" ? "buttons" : "options";
    const items = Array.isArray(config[field]) ? [...(config[field] as Record<string, unknown>[])] : [];
    const at = items.findIndex((item) => item?.id === keyed[2]);
    if (at < 0) return false;
    items[at] = { ...items[at], steps };
    config[field] = items;
    return true;
  }
  return false;
}

/** The model's envelope as engine steps. Problems the validator can't see are added to `issues`. */
export function fromEnvelope(raw: unknown, issues: Issue[], depth = 0): Step[] {
  if (!Array.isArray(raw)) return [];
  const out: Step[] = [];
  for (const entry of raw.slice(0, LIMITS.totalSteps + 1)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<EnvelopeStep>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const type = typeof e.type === "string" ? e.type : "";
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(typeof e.config_json === "string" && e.config_json.trim() ? e.config_json : "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
      else issues.push({ path: `steps.${id}`, stepId: id || null, message: "This step's settings must be an object." });
    } catch {
      issues.push({ path: `steps.${id}`, stepId: id || null, message: "This step's settings weren't valid JSON." });
    }
    if (depth <= LIMITS.depth) {
      for (const child of Array.isArray(e.children) ? e.children : []) {
        if (!child || typeof child.list !== "string") continue;
        const steps = fromEnvelope(child.steps, issues, depth + 1);
        if (!attachChild(type, config, child.list, steps)) {
          issues.push({ path: `steps.${id}`, stepId: id || null, message: `"${child.list.slice(0, 20)}" isn't one of this step's step lists.` });
        }
      }
    }
    out.push({
      id,
      type,
      ...(typeof e.label === "string" && e.label.trim() ? { label: e.label.trim().slice(0, 80) } : {}),
      ...(e.continueOnError === true ? { continueOnError: true } : {}),
      config,
    });
  }
  return out;
}

export type RawCommand = {
  name?: unknown;
  description?: unknown;
  ephemeral?: unknown;
  options?: unknown;
  access?: unknown;
  cooldowns?: unknown;
  limits?: unknown;
  steps?: unknown;
};

/** Drops the schema's nulls ("not set") so options match the engine's optional keys. */
function cleanOption(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0 && (key === "choices" || key === "autocomplete" || key === "channelTypes")) continue;
    out[key] = value;
  }
  return out;
}

/** The model's command as a candidate v3 program (not yet validated). */
export function assembleProgram(raw: RawCommand, issues: Issue[]): { name: string; program: Record<string, unknown> } {
  const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase().replace(/^\//, "").replace(/\s+/g, "-") : "";
  return {
    name,
    program: {
      version: PROGRAM_VERSION,
      description: typeof raw.description === "string" ? raw.description.trim() : "",
      ephemeral: raw.ephemeral === true,
      options: Array.isArray(raw.options) ? raw.options.map(cleanOption) : [],
      access: raw.access ?? {},
      cooldowns: raw.cooldowns ?? {},
      limits: raw.limits ?? {},
      steps: fromEnvelope(raw.steps, issues),
    },
  };
}

// ── Checks (the same ones saving runs) ──────────────────────────────────────────────────────

export type DraftCheck =
  | { ok: true; name: string; program: CommandProgram }
  | { ok: false; issues: Issue[]; missing: string[] };

/** Picks a free name: the model's, or the same with -2, -3... when it's taken. */
export function freeName(name: string, taken: Set<string>, reserved: Set<string>): string {
  if (!taken.has(name) && !reserved.has(name)) return name;
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${name.slice(0, 32 - suffix.length)}${suffix}`;
    if (!taken.has(candidate) && !reserved.has(candidate)) return candidate;
  }
  return name;
}

/**
 * Runs everything saving would: the program validator (shape, every setting, nesting, step and
 * option limits, form placement, targets), this guild's ids, and the builder-permission check
 * against the requesting member. A step the builder couldn't save makes the draft invalid.
 */
export function checkDraft(
  guild: Guild,
  actor: ActorInfo,
  raw: RawCommand,
  opts: { taken: Set<string>; reserved: Set<string>; keepName?: string | null; allowedTypes: string[] },
): DraftCheck {
  const issues: Issue[] = [];
  const assembled = assembleProgram(raw, issues);
  let name = opts.keepName ?? assembled.name;
  if (!opts.keepName) {
    const problem = commandNameProblem(name, new Set());
    if (problem) issues.push({ path: "name", stepId: null, message: `Command name: ${problem}` });
    else name = freeName(name, opts.taken, opts.reserved);
  }

  const allowed = new Set(opts.allowedTypes);
  const walk = (steps: Step[]) => {
    for (const step of steps) {
      if (ACTION_MAP.has(step.type) && !allowed.has(step.type)) {
        issues.push({ path: `steps.${step.id}`, stepId: step.id, message: `The ${ACTION_MAP.get(step.type)!.label} step isn't available to you here.` });
      }
      for (const list of childLists(step)) walk(list.steps);
    }
  };
  walk(assembled.program.steps as Step[]);

  const validated = validateProgram(assembled.program);
  issues.push(...validated.issues);
  if (!validated.program || issues.length) return { ok: false, issues, missing: [] };

  const program = validated.program;
  const idIssues = checkGuildIds(guild, program);
  if (idIssues.length) return { ok: false, issues: idIssues, missing: [] };

  const report = builderReport(guild, actor, collectRequirements(program));
  if (report.missing.length || report.problems.length) {
    return {
      ok: false,
      missing: report.missing,
      issues: report.problems.map((p) => ({ path: p.stepId ? `steps.${p.stepId}` : "", stepId: p.stepId, message: p.message })),
    };
  }
  return { ok: true, name, program };
}

/** One readable line per problem, for the repair turn and for the error shown to the user. */
export function describeIssues(issues: Issue[], max = 12): string {
  return issues
    .slice(0, max)
    .map((i) => `- ${i.path || "command"}: ${i.message}`)
    .join("\n");
}

// ── Prompt ──────────────────────────────────────────────────────────────────────────────────

function fieldLine(field: CatalogField): string {
  const bits: string[] = [field.kind];
  if (field.required) bits.push("required");
  if (field.kind === "select" && field.options?.length) bits.push(`one of ${field.options.map((o) => o.value).join("|")}`);
  if (field.kind === "number") {
    if (field.integer) bits.push("whole");
    if (field.min !== undefined) bits.push(`min ${field.min}`);
    if (field.max !== undefined) bits.push(`max ${field.max}`);
  }
  if (field.maxLength) bits.push(`max ${field.maxLength} chars`);
  if (field.showIf) bits.push(`only when ${field.showIf.key} is ${field.showIf.in.join("|")}`);
  return `${field.key} (${bits.join(", ")})`;
}

function actionCatalog(allowedTypes: string[]): string {
  const allowed = new Set(allowedTypes);
  return ACTIONS.filter((def) => allowed.has(def.type))
    .map((def) => {
      const fields = def.fields.length ? ` Settings: ${def.fields.map(fieldLine).join("; ")}.` : "";
      const outputs = def.outputs.length ? ` Outputs: ${def.outputs.map((o) => `{<id>.${o.key}}`).join(", ")}.` : "";
      return `- ${def.type}: ${def.description}${fields}${outputs}`;
    })
    .join("\n");
}

function conditionCatalog(): string {
  return CONDITIONS.map((c) => `- ${c.type}: ${c.description} Settings: ${c.fields.map(fieldLine).join("; ") || "none"}.`).join("\n");
}

const FORMAT_RULES = `How a command is written:
- name: 1-32 characters of lowercase letters, numbers, - and _. description: 1-100 characters, shown in Discord.
- ephemeral: true when replies should only be seen by the person who ran it.
- options (up to ${LIMITS.options}): what people fill in. type is one of ${OPTION_TYPES.join(", ")}. Required options come first. Option names follow the same rules as command names. Use null for settings you don't need. choices (up to ${LIMITS.choices}) only for text, integer and number options.
- access: roles (needs any or all, per rolesMode), blockedRoles, permissions the runner needs (Discord permission names like ManageMessages), channels/blockedChannels (empty means everywhere), visibility (permission names; who sees it in Discord's list, empty for everyone). Use empty lists when not asked for.
- cooldowns in seconds (user, channel, global; 0 = none, max ${LIMITS.cooldownSeconds}). limits: perUserDaily, guildDaily (0 = none).
- steps run from top to bottom (up to ${LIMITS.totalSteps} in total, blocks nested at most ${LIMITS.depth} deep). Every step id is unique across the whole command: use step1, step2, step3 and so on in order, nested ones included.
- config_json is the step's settings as a JSON object string. Leave out settings you don't need; defaults fill them in. Never put ids from another server.
- A message setting is an object: {"format":"text","content":"..."} or {"format":"embed","content":"","embed":{"title":"...","description":"...","color":5793266}} or {"format":"container","container":{"title":"...","body":"..."}}. Optional "variants": several texts, one picked at random. Messages are at most ${LIMITS.textLength} characters.
- Variables in text: ${VARIABLE_DOCS.map((v) => `{${v.key}}`).join(", ")}; {option.<name>} (and .mention, .name, .id for user, member, role and channel options); {<stepId>.<output>} for an earlier step's output; {var.<name>} after set_variable; {form.<question id>} after a form; {loop.index}, {loop.item} inside Repeat; {press.user.mention} inside a button or menu choice. Add a fallback with a bar: {option.reason|No reason given}.
- Target settings (user_target, role_target, channel_target) take one picked id or exactly one variable: users {user.id}, {option.<name>.id}, {press.user.id}, {loop.item.id} or a member output of an earlier step; roles a role id from the list below, {option.<name>.id} or {<stepId>.role.id}; channels a channel id from the list below, {channel.id}, {option.<name>.id} or {<stepId>.channel.id}. Moderation steps (kick, ban, timeout...) may only target a user option. DMs only go to {user.id} or a user option.
- Blocks keep their nested steps in children, each with a list key: if uses "b0", "b1"... (one per branch, in order) and "else"; repeat and repeat_each use "steps"; random_branch uses "r0", "r1"...; buttons use "btn:<button id>"; select_menu uses "opt:<choice id>". Inside config_json write each branch, button or choice with "steps": [].
  If config: {"branches":[{"match":"all","conditions":[{"type":"compare","left":"{option.colour}","op":"eq","right":"red"}],"steps":[]}],"else":[]}. Up to ${LIMITS.branches} branches, ${LIMITS.conditions} conditions each; any condition takes "negate": true.
  Buttons config: {"message":{"format":"text","content":"Pick one"},"who":"runner","buttons":[{"id":"b1","label":"Yes","style":"success","emoji":"","steps":[]}]} (button and choice ids: 1-8 lowercase letters or numbers, up to ${LIMITS.buttons} buttons, ${LIMITS.selectOptions} choices).
  Form config: {"title":"Tell us more","inputs":[{"id":"reason","label":"Why?","style":"paragraph","required":true,"placeholder":"","minLength":null,"maxLength":null}]} (up to ${LIMITS.formInputs} questions). A form must be the very first step, or the first step inside a button or menu choice.
- Repeat runs at most ${LIMITS.repeatTimes} times; Repeat for each at most ${LIMITS.repeatEach} items. Waits total at most ${LIMITS.waitTotalSeconds} seconds per run.

Example, a coin flip with a cooldown:
{"name":"flip","description":"Flip a coin","ephemeral":false,"options":[],"access":{"roles":[],"rolesMode":"any","blockedRoles":[],"permissions":[],"channels":[],"blockedChannels":[],"visibility":[]},"cooldowns":{"user":10,"channel":0,"global":0},"limits":{"perUserDaily":0,"guildDaily":0},"steps":[{"id":"step1","type":"random_branch","label":null,"continueOnError":false,"config_json":"{\\"branches\\":[{\\"weight\\":1,\\"steps\\":[]},{\\"weight\\":1,\\"steps\\":[]}]}","children":[{"list":"r0","steps":[{"id":"step2","type":"reply","label":null,"continueOnError":false,"config_json":"{\\"message\\":{\\"format\\":\\"text\\",\\"content\\":\\"Heads, {user.mention}.\\"}}","children":[]}]},{"list":"r1","steps":[{"id":"step3","type":"reply","label":null,"continueOnError":false,"config_json":"{\\"message\\":{\\"format\\":\\"text\\",\\"content\\":\\"Tails, {user.mention}.\\"}}","children":[]}]}]}]}`;

export type DreamCommandPromptInput = {
  ctx: AiWizardContext;
  allowedTypes: string[];
  questionsAsked: number;
  /** Refining: the current draft (as the envelope, so it reads like the answer format). */
  current: { name: string; program: CommandProgram | Record<string, unknown> } | null;
  takenNames: string[];
};

function currentDraftJson(current: NonNullable<DreamCommandPromptInput["current"]>): string {
  const p = current.program as Partial<CommandProgram>;
  let steps: unknown = [];
  try {
    steps = Array.isArray(p.steps) ? toEnvelope(p.steps as Step[]) : [];
  } catch {
    // A half-built draft the envelope can't read: show it as it is.
    steps = p.steps ?? [];
  }
  return JSON.stringify({
    name: current.name,
    description: p.description ?? "",
    ephemeral: p.ephemeral === true,
    options: p.options ?? [],
    access: p.access ?? {},
    cooldowns: p.cooldowns ?? {},
    limits: p.limits ?? {},
    steps,
  });
}

export function buildDreamCommandPrompt(input: DreamCommandPromptInput): string {
  const { ctx, allowedTypes, questionsAsked, current, takenNames } = input;
  const unavailable = ACTIONS.filter((def) => !allowedTypes.includes(def.type)).map((def) => def.type);
  const emojis = ctx.emojis.slice(0, 60).map((e) => `${e.animated ? "<a:" : "<:"}${e.name}:${e.id}>`);
  return (
    `You are Autopilot, building a Dreamliner custom slash command for the Discord server "${ctx.guildName}". ` +
    "Custom commands are made from steps, like a shortcut: no code. " +
    (current
      ? "The user is refining the command below. Apply what they ask, keep everything else exactly as it is (ids, wording, settings), and return the whole updated command.\n\n" +
        `Current command:\n${currentDraftJson(current)}\n\n`
      : "Build a complete, working command from what the user describes.\n\n") +
    progressInstruction(questionsAsked, DREAM_COMMAND_MAX_QUESTIONS) +
    "Build straight away whenever the request is clear enough, choosing sensible defaults. Only ask a question " +
    "(action \"ask\") when something essential is missing, such as which role to give when the server has several " +
    "likely ones. Ask one short question at a time. When you build, respond with action \"ready\", the full command " +
    "in config, and a summary: one or two calm sentences on what the command does, in British English, no " +
    "exclamation marks. " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\n" +
    FORMAT_RULES +
    "\n\nSteps you can use (type: what it does, then its settings):\n" +
    actionCatalog(allowedTypes) +
    (unavailable.length
      ? `\n\nNot available to this user (their plugin is off or they lack the permissions), never use them: ${unavailable.join(", ")}. If the request needs one, build the closest command without it and say so in the summary.`
      : "") +
    "\n\nConditions for If branches:\n" +
    conditionCatalog() +
    `\n\nThis server's text and announcement channels (id: "name"):\n${entityList(ctx.textChannels)}` +
    `\n\nVoice channels:\n${entityList(ctx.voiceChannels)}` +
    `\n\nCategories:\n${entityList(ctx.categories)}` +
    `\n\nRoles:\n${entityList(ctx.roles)}` +
    `\n\nCustom emojis (use exactly as written): ${emojis.length ? emojis.join(" ") : "(none)"}` +
    (takenNames.length && !current ? `\n\nCommand names already used on this server (pick another): ${takenNames.slice(0, 100).join(", ")}` : "")
  );
}

/** The turn sent after a draft failed the checks: lists the problems and asks for a fixed one. */
export function repairMessage(issues: Issue[], missing: string[]): string {
  return (
    "That command didn't pass Dreamliner's checks:\n" +
    describeIssues(issues) +
    (missing.length ? `\nThe user lacks these permissions, so remove or replace the steps that need them: ${missing.join(", ")}.` : "") +
    '\nReturn the whole corrected command with action "ready". Keep everything that was fine.'
  );
}
