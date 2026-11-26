/**
 * The step interpreter: an explicit stack machine (no recursion), so a run can pause at a long
 * Wait or a form and be resumed later from a saved stack, even after a restart.
 *
 * Caps: LIMITS.executedSteps steps per run, LIMITS.runBudgetMs of work (waits excluded),
 * LIMITS.apiCalls Discord calls, LIMITS.waitTotalSeconds of waiting, repeat and for-each caps.
 * A failing step ends the run with its friendly message unless it is marked continue-on-error.
 */
import { ActionRowBuilder, ButtonBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import type { ActionDef } from "./action.js";
import { evaluateCondition } from "./conditions.js";
import { BUTTON_STYLES } from "./message.js";
import { render, resolveEphemeral } from "./actions/messages.js";
import { ACTION_MAP } from "./registry.js";
import { checkDeadline, friendlyError, spendApi, StepError, StopRun, type RunCtx } from "./runtime.js";
import { LIMITS, type ButtonSpec, type Condition, type FormInput, type MessageSpec, type SelectOptionSpec, type Step, type VarValue } from "./types.js";
import { resolveList } from "./validate.js";
import { interpolate, setVar } from "./vars.js";

export type Frame = {
  block: string | null;
  key: string;
  index: number;
  loop?: { kind: "repeat" | "each"; i: number; count: number; items?: string[]; ids?: (string | null)[] };
};

export type RunOutcome =
  | { status: "ok"; warnings: string[] }
  | { status: "stopped"; message: string | null; isError: boolean; warnings: string[] }
  | { status: "error"; stepId: string | null; error: string; warnings: string[] }
  | { status: "waiting"; resumeAt: number; warnings: string[] }
  | { status: "form"; warnings: string[] };

export type SavedVars = { values: Array<[string, VarValue]>; trusted: string[] };

export type Continuation = {
  stack: Frame[];
  vars: SavedVars;
  counters: RunCtx["counters"];
  created: { channels: string[]; roles: string[] };
  messages: Array<[string, { channelId: string; messageId: string }]>;
  optionUserIds: string[];
};

export type FollowupState = {
  kind: "buttons" | "select" | "form";
  blockId: string;
  runnerId: string;
  channelId: string;
  who?: "anyone" | "runner" | "roles";
  roleIds?: string[];
  singleUse?: boolean;
  labels?: Record<string, string>;
  /** Saved when the follow-up was created: the program version it belongs to. */
  commandUpdatedAt: number;
  builderId: string;
  continuation: Continuation;
};

export type InterpreterDeps = {
  actions?: Map<string, ActionDef>;
  /** Stores a follow-up and returns its id (used in the component custom id). */
  saveFollowup?: (ctx: RunCtx, state: FollowupState, ttlMs: number) => Promise<string>;
  attachFollowupMessage?: (id: string, messageId: string) => Promise<void>;
  /** Stores a paused run; returns when it should resume. */
  saveWait?: (ctx: RunCtx, continuation: Continuation, resumeAt: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Program updatedAt (ms), stored with follow-ups so stale ones expire after an edit. */
  commandUpdatedAt?: number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function saveVars(ctx: RunCtx): SavedVars {
  return { values: [...ctx.vars.values.entries()], trusted: [...ctx.vars.trusted] };
}

export function snapshot(ctx: RunCtx, stack: Frame[]): Continuation {
  return {
    stack: stack.map((f) => ({ ...f, loop: f.loop ? { ...f.loop, items: f.loop.items ? [...f.loop.items] : undefined, ids: f.loop.ids ? [...f.loop.ids] : undefined } : undefined })),
    vars: saveVars(ctx),
    counters: { ...ctx.counters },
    created: { channels: [...ctx.created.channels], roles: [...ctx.created.roles] },
    messages: [...ctx.messages.entries()],
    optionUserIds: [...ctx.optionUserIds],
  };
}

function applyLoopVars(ctx: RunCtx, frame: Frame): void {
  const loop = frame.loop;
  if (!loop) return;
  setVar(ctx.vars, "loop.index", loop.i + 1, true);
  if (loop.kind === "each") {
    const item = loop.items?.[loop.i] ?? "";
    const id = loop.ids?.[loop.i] ?? null;
    setVar(ctx.vars, "loop.item", item);
    if (id) {
      setVar(ctx.vars, "loop.item.id", id, true);
      setVar(ctx.vars, "loop.item.mention", `<@${id}>`, true);
    } else {
      ctx.vars.values.delete("loop.item.id");
      ctx.vars.values.delete("loop.item.mention");
    }
  }
}

function eachItems(ctx: RunCtx, config: Record<string, unknown>): { items: string[]; ids: (string | null)[] } {
  const limit = Math.min(LIMITS.repeatEach, Math.max(1, Number(config.limit) || LIMITS.repeatEach));
  if (config.source === "role_members") {
    const role = ctx.guild.roles.cache.get(String(config.roleId ?? ""));
    if (!role) throw new StepError("The role for this loop isn't in this server any more.");
    const members = [...role.members.values()].slice(0, limit);
    return { items: members.map((m) => m.displayName), ids: members.map((m) => m.id) };
  }
  const source = String(config.list ?? "");
  const single = /^\{([a-z0-9_.:-]+)\}$/.exec(source.trim())?.[1];
  const value = single ? ctx.vars.values.get(single) : undefined;
  let items: string[];
  if (Array.isArray(value)) items = value;
  else {
    const text = interpolate(source, ctx.vars, { mode: "raw", rng: ctx.rng });
    items = text.split(config.separator === "comma" ? "," : "\n");
  }
  items = items.map((s) => s.trim()).filter(Boolean).slice(0, limit);
  return { items, ids: items.map(() => null) };
}

function pickWeighted(branches: { weight: number }[], rng: () => number): number {
  const total = branches.reduce((sum, b) => sum + Math.max(0, b.weight), 0);
  if (total <= 0) return Math.floor(rng() * branches.length);
  let roll = rng() * total;
  for (let i = 0; i < branches.length; i++) {
    roll -= Math.max(0, branches[i]!.weight);
    if (roll < 0) return i;
  }
  return branches.length - 1;
}

async function conditionsMatch(ctx: RunCtx, match: string, conditions: Condition[]): Promise<boolean> {
  if (!conditions.length) return false;
  if (match === "any") {
    for (const c of conditions) if (await evaluateCondition(ctx, c)) return true;
    return false;
  }
  for (const c of conditions) if (!(await evaluateCondition(ctx, c))) return false;
  return true;
}

export const COMPONENT_PREFIX = "dlcc:";

function emojiOf(raw: string): { id?: string; name?: string; animated?: boolean } | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const custom = /^<(a?):(\w{2,32}):(\d{15,22})>$/.exec(text);
  if (custom) return { id: custom[3], name: custom[2], animated: custom[1] === "a" };
  return { name: text.slice(0, 32) };
}

async function sendInteractive(ctx: RunCtx, step: Step, stack: Frame[], deps: Required<Pick<InterpreterDeps, "saveFollowup" | "attachFollowupMessage">> & InterpreterDeps): Promise<void> {
  const config = step.config as Record<string, unknown>;
  const isButtons = step.type === "buttons";
  const labels: Record<string, string> = {};
  const items = (isButtons ? (config.buttons as ButtonSpec[]) : (config.options as SelectOptionSpec[])) ?? [];
  for (const item of items) labels[item.id] = item.label;
  const state: FollowupState = {
    kind: isButtons ? "buttons" : "select",
    blockId: step.id,
    runnerId: ctx.runner.id,
    channelId: ctx.channelId,
    who: (config.who as FollowupState["who"]) ?? "runner",
    roleIds: Array.isArray(config.roleIds) ? (config.roleIds as string[]).slice(0, 10) : [],
    singleUse: config.singleUse === true,
    labels,
    commandUpdatedAt: deps.commandUpdatedAt ?? 0,
    builderId: ctx.builderId,
    continuation: snapshot(ctx, stack),
  };
  const id = await deps.saveFollowup(ctx, state, LIMITS.followupHours * 3600_000);
  let row: Record<string, unknown>;
  if (isButtons) {
    row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        (config.buttons as ButtonSpec[]).slice(0, LIMITS.buttons).map((b) => {
          const button = new ButtonBuilder().setCustomId(`${COMPONENT_PREFIX}b:${id}:${b.id}`).setLabel(interpolate(b.label, ctx.vars, { mode: "raw", rng: ctx.rng }).slice(0, 80) || "Button").setStyle(BUTTON_STYLES[b.style] ?? BUTTON_STYLES.primary!);
          const emoji = emojiOf(b.emoji);
          if (emoji) button.setEmoji(emoji);
          return button;
        }),
      )
      .toJSON() as unknown as Record<string, unknown>;
  } else {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${COMPONENT_PREFIX}s:${id}`)
      .setPlaceholder(String(config.placeholder ?? "").slice(0, 150) || "Pick one")
      .addOptions(
        (config.options as SelectOptionSpec[]).slice(0, LIMITS.selectOptions).map((o) => {
          const opt: { label: string; value: string; description?: string; emoji?: ReturnType<typeof emojiOf> } = { label: interpolate(o.label, ctx.vars, { mode: "raw", rng: ctx.rng }).slice(0, 100) || "Choice", value: o.id };
          if (o.description.trim()) opt.description = o.description.slice(0, 100);
          const emoji = emojiOf(o.emoji);
          if (emoji) opt.emoji = emoji;
          return opt;
        }),
      );
    row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu).toJSON() as unknown as Record<string, unknown>;
  }
  const ephemeral = resolveEphemeral(ctx, config.ephemeral);
  spendApi(ctx);
  const message = await ctx.responder.send(render(ctx, config.message as MessageSpec, [row]), ephemeral);
  if (message?.id) {
    await deps.attachFollowupMessage(id, message.id);
    if (!ephemeral) {
      ctx.messages.set(step.id, { channelId: message.channelId ?? ctx.channelId, messageId: message.id });
      if (!ctx.messages.has("reply")) ctx.messages.set("reply", { channelId: message.channelId ?? ctx.channelId, messageId: message.id });
    }
    setVar(ctx.vars, `${step.id}.message.id`, message.id, true);
  }
}

export function buildModal(customId: string, title: string, inputs: FormInput[]): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45) || "Form");
  for (const input of inputs.slice(0, LIMITS.formInputs)) {
    const field = new TextInputBuilder()
      .setCustomId(input.id)
      .setLabel(input.label.slice(0, 45) || "Answer")
      .setStyle(input.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(input.required);
    if (input.placeholder.trim()) field.setPlaceholder(input.placeholder.slice(0, 100));
    if (input.minLength != null) field.setMinLength(Math.min(4000, input.minLength));
    if (input.maxLength != null) field.setMaxLength(Math.min(4000, Math.max(1, input.maxLength)));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
  }
  return modal;
}

/** Runs from the given stack until the end, a stop, an error, a long wait or a form. */
export async function execute(ctx: RunCtx, stack: Frame[], deps: InterpreterDeps = {}): Promise<RunOutcome> {
  const actions = deps.actions ?? ACTION_MAP;
  const sleep = deps.sleep ?? realSleep;
  const warnings: string[] = [];

  try {
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const list = resolveList(ctx.program, frame.block, frame.key);
      if (!list) return { status: "error", stepId: frame.block, error: "This command changed while it was running.", warnings };

      if (frame.index >= list.length) {
        if (frame.loop && frame.loop.i + 1 < frame.loop.count) {
          frame.loop.i += 1;
          frame.index = 0;
          applyLoopVars(ctx, frame);
          continue;
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent?.loop) applyLoopVars(ctx, parent);
        continue;
      }

      const step = list[frame.index]!;
      frame.index += 1;
      if (step.disabled) continue;

      ctx.counters.steps += 1;
      if (ctx.counters.steps > LIMITS.executedSteps) {
        return { status: "error", stepId: step.id, error: `This command ran more than ${LIMITS.executedSteps} steps and was stopped.`, warnings };
      }

      const def = actions.get(step.type);
      if (!def) return { status: "error", stepId: step.id, error: "This step type no longer exists.", warnings };
      const config = step.config as Record<string, unknown>;

      try {
        checkDeadline(ctx);
        switch (step.type) {
          case "if": {
            const branches = (config.branches as { match: string; conditions: Condition[]; steps: Step[] }[]) ?? [];
            let chosen: string | null = null;
            for (let i = 0; i < branches.length; i++) {
              if (await conditionsMatch(ctx, branches[i]!.match, branches[i]!.conditions)) {
                chosen = `b${i}`;
                break;
              }
            }
            stack.push({ block: step.id, key: chosen ?? "else", index: 0 });
            break;
          }
          case "repeat": {
            const count = Math.min(LIMITS.repeatTimes, Math.max(0, Math.floor(Number(config.times) || 0)));
            if (count > 0) {
              const f: Frame = { block: step.id, key: "steps", index: 0, loop: { kind: "repeat", i: 0, count } };
              stack.push(f);
              applyLoopVars(ctx, f);
            }
            break;
          }
          case "repeat_each": {
            const { items, ids } = eachItems(ctx, config);
            if (items.length) {
              const f: Frame = { block: step.id, key: "steps", index: 0, loop: { kind: "each", i: 0, count: items.length, items, ids } };
              stack.push(f);
              applyLoopVars(ctx, f);
            }
            break;
          }
          case "random_branch": {
            const branches = (config.branches as { weight: number }[]) ?? [];
            if (branches.length) {
              const i = pickWeighted(branches, ctx.rng);
              setVar(ctx.vars, `${step.id}.picked`, i + 1, true);
              stack.push({ block: step.id, key: `r${i}`, index: 0 });
            }
            break;
          }
          case "wait": {
            const seconds = Math.max(1, Math.floor(Number(config.seconds) || 1));
            if (ctx.counters.waitedSeconds + seconds > LIMITS.waitTotalSeconds) throw new StepError(`A run can wait at most ${LIMITS.waitTotalSeconds / 60} minutes in total.`);
            ctx.counters.waitedSeconds += seconds;
            if (seconds <= LIMITS.inlineWaitSeconds || !deps.saveWait) {
              ctx.deadline += seconds * 1000;
              await sleep(seconds * 1000);
            } else {
              const resumeAt = Date.now() + seconds * 1000;
              await deps.saveWait(ctx, snapshot(ctx, stack), resumeAt);
              return { status: "waiting", resumeAt, warnings };
            }
            break;
          }
          case "stop": {
            const message = interpolate(String(config.message ?? ""), ctx.vars, { mode: "message", rng: ctx.rng }).trim().slice(0, 500);
            throw new StopRun(message || null, config.asError === true);
          }
          case "buttons":
          case "select_menu": {
            if (!deps.saveFollowup || !deps.attachFollowupMessage) throw new StepError("Buttons and menus aren't available here.");
            await sendInteractive(ctx, step, stack, deps as Required<Pick<InterpreterDeps, "saveFollowup" | "attachFollowupMessage">> & InterpreterDeps);
            break;
          }
          case "form": {
            if (!ctx.responder.canShowModal || !deps.saveFollowup) throw new StepError("A form can only be shown as the very first response.");
            const state: FollowupState = {
              kind: "form",
              blockId: step.id,
              runnerId: ctx.runner.id,
              channelId: ctx.channelId,
              commandUpdatedAt: deps.commandUpdatedAt ?? 0,
              builderId: ctx.builderId,
              continuation: snapshot(ctx, stack),
            };
            const id = await deps.saveFollowup(ctx, state, 30 * 60_000);
            const title = interpolate(String(config.title ?? ""), ctx.vars, { mode: "raw", rng: ctx.rng });
            await ctx.responder.showModal(buildModal(`${COMPONENT_PREFIX}f:${id}`, title, (config.inputs as FormInput[]) ?? []));
            return { status: "form", warnings };
          }
          default: {
            if (!def.run) throw new StepError("This step can't run.");
            const result = await def.run(ctx, config, step);
            if (result?.outputs) {
              const trusted = new Set(result.trusted ?? []);
              for (const [key, value] of Object.entries(result.outputs)) setVar(ctx.vars, `${step.id}.${key}`, value, trusted.has(key));
            }
          }
        }
      } catch (error) {
        if (error instanceof StopRun) throw error;
        const message = friendlyError(error);
        if (step.continueOnError) {
          warnings.push(`${step.id}: ${message}`);
          setVar(ctx.vars, `${step.id}.error`, message);
          continue;
        }
        return { status: "error", stepId: step.id, error: message, warnings };
      }
    }
    return { status: "ok", warnings };
  } catch (error) {
    if (error instanceof StopRun) return { status: "stopped", message: error.userMessage, isError: error.isError, warnings };
    return { status: "error", stepId: null, error: friendlyError(error), warnings };
  }
}

/** The first reply-like step in run order, to decide whether the deferred reply is private. */
export function firstReplyEphemeral(steps: Step[], fallback: boolean): boolean {
  for (const step of steps) {
    if (step.disabled) continue;
    const c = step.config as Record<string, unknown>;
    if (["reply", "buttons", "select_menu"].includes(step.type)) {
      if (c.ephemeral === "yes" || c.ephemeral === true) return true;
      if (c.ephemeral === "no" || c.ephemeral === false) return false;
      return fallback;
    }
    if (step.type === "poll") return false;
    if (step.type === "if") {
      const first = (c.branches as { steps: Step[] }[] | undefined)?.[0]?.steps ?? [];
      const found = firstReplyEphemeralOrNull(first);
      if (found !== null) return found;
    }
    if (step.type === "repeat" || step.type === "repeat_each") {
      const found = firstReplyEphemeralOrNull((c.steps as Step[]) ?? []);
      if (found !== null) return found;
    }
  }
  return fallback;

  function firstReplyEphemeralOrNull(list: Step[]): boolean | null {
    const marker = Symbol.for("none");
    const r = firstReplyEphemeral(list, marker as unknown as boolean);
    return (r as unknown) === marker ? null : r;
  }
}
