import { getActionDef } from "./actions.js";
import { DreamcodeAbort, DreamcodeError } from "./errors.js";
import type {
  ActionArg,
  ActionHost,
  BoundActionArgs,
  DreamObject,
  DreamValue,
  Expr,
  InterpretLimits,
  Program,
  SourcePos,
  Stmt,
} from "./types.js";
import { DEFAULT_LIMITS } from "./types.js";

export type InterpretOptions = {
  globals: Record<string, DreamValue>;
  host: ActionHost;
  limits?: Partial<InterpretLimits>;
  sleep?: (ms: number) => Promise<void>;
};

export type InterpretResult =
  | { ok: true }
  | { ok: false; aborted: true; message: string }
  | { ok: false; aborted: false; error: DreamcodeError };

export async function interpretDreamcode(program: Program, options: InterpretOptions): Promise<InterpretResult> {
  const limits: InterpretLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const vars = new Map<string, DreamValue>();
  const started = Date.now();
  let steps = 0;
  let waitUsed = 0;

  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const tick = (pos?: SourcePos) => {
    steps++;
    if (steps > limits.maxSteps) {
      throw new DreamcodeError("runtime", `Exceeded max steps (${limits.maxSteps})`, pos);
    }
    if (Date.now() - started > limits.maxDurationMs) {
      throw new DreamcodeError("runtime", `Exceeded max duration (${limits.maxDurationMs}ms)`, pos);
    }
  };

  const resolvePath = (parts: string[], pos: SourcePos): DreamValue => {
    if (parts.length === 0) return null;
    const root = parts[0]!;
    let current: DreamValue;
    if (vars.has(root)) {
      current = vars.get(root)!;
    } else if (root in options.globals) {
      current = options.globals[root]!;
    } else {
      return null;
    }
    for (let i = 1; i < parts.length; i++) {
      const key = parts[i]!;
      if (current === null || current === undefined) return null;
      if (typeof current === "object" && !Array.isArray(current)) {
        current = (current as DreamObject)[key] ?? null;
        continue;
      }
      if (Array.isArray(current) && /^\d+$/.test(key)) {
        current = current[Number(key)] ?? null;
        continue;
      }
      throw new DreamcodeError("runtime", `Cannot read property '${key}'`, pos);
    }
    return current ?? null;
  };

  const interpolate = (template: string, pos: SourcePos): string => {
    return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)\}/g, (_m, path: string) => {
      const value = resolvePath(path.split("."), pos);
      return stringifyValue(value);
    });
  };

  const bindArgs = async (actionName: string, args: ActionArg[], pos: SourcePos): Promise<BoundActionArgs> => {
    const def = getActionDef(actionName);
    if (!def) throw new DreamcodeError("runtime", `Unknown action '${actionName}'`, pos);
    const bound: BoundActionArgs = {};
    let pi = 0;
    for (const arg of args) {
      if (arg.kind === "positional") {
        const param = def.positional[pi];
        if (!param) throw new DreamcodeError("runtime", `Too many arguments for '${actionName}'`, pos);
        bound[param.name] = await evalExpr(arg.value);
        pi++;
      } else {
        bound[arg.name] = await evalExpr(arg.value);
      }
    }
    return bound;
  };

  const runAction = async (name: string, args: ActionArg[], pos: SourcePos): Promise<DreamValue> => {
    tick(pos);
    const bound = await bindArgs(name, args, pos);
    if (name === "wait") {
      const ms = parseWaitMs(bound.duration, pos);
      if (waitUsed + ms > limits.maxWaitMs) {
        throw new DreamcodeError("runtime", `Wait budget exceeded (max ${limits.maxWaitMs}ms per run)`, pos);
      }
      waitUsed += ms;
      await sleep(ms);
      vars.set("result", null);
      return null;
    }
    const value = await options.host.run(name, bound, pos);
    vars.set("result", value ?? null);
    return value ?? null;
  };

  const evalExpr = async (expr: Expr): Promise<DreamValue> => {
    tick(expr.pos);
    switch (expr.kind) {
      case "literal":
        if (typeof expr.value === "string") return interpolate(expr.value, expr.pos);
        return expr.value;
      case "path":
        return resolvePath(expr.parts, expr.pos);
      case "action":
        return runAction(expr.name, expr.args, expr.pos);
      case "unary":
        if (expr.op === "not") return !isTruthy(await evalExpr(expr.operand));
        return null;
      case "binary": {
        if (expr.op === "and") {
          const left = await evalExpr(expr.left);
          return isTruthy(left) ? await evalExpr(expr.right) : left;
        }
        if (expr.op === "or") {
          const left = await evalExpr(expr.left);
          return isTruthy(left) ? left : await evalExpr(expr.right);
        }
        const left = await evalExpr(expr.left);
        const right = await evalExpr(expr.right);
        switch (expr.op) {
          case "==":
            return eq(left, right);
          case "!=":
            return !eq(left, right);
          case "<":
            return toNumber(left, expr.pos) < toNumber(right, expr.pos);
          case "<=":
            return toNumber(left, expr.pos) <= toNumber(right, expr.pos);
          case ">":
            return toNumber(left, expr.pos) > toNumber(right, expr.pos);
          case ">=":
            return toNumber(left, expr.pos) >= toNumber(right, expr.pos);
          default:
            return null;
        }
      }
    }
  };

  const runStmt = async (stmt: Stmt): Promise<void> => {
    tick(stmt.pos);
    switch (stmt.kind) {
      case "set":
        vars.set(stmt.name, await evalExpr(stmt.value));
        return;
      case "require":
        if (!isTruthy(await evalExpr(stmt.value))) {
          throw new DreamcodeAbort("Required value was missing or empty.");
        }
        return;
      case "error": {
        const msg = stringifyValue(await evalExpr(stmt.message)) || "Command error";
        throw new DreamcodeAbort(msg);
      }
      case "if": {
        const body = isTruthy(await evalExpr(stmt.condition)) ? stmt.thenBody : stmt.elseBody;
        for (const s of body) await runStmt(s);
        return;
      }
      case "action":
        await runAction(stmt.name, stmt.args, stmt.pos);
        return;
    }
  };

  try {
    for (const stmt of program.body) {
      await runStmt(stmt);
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof DreamcodeAbort) {
      return { ok: false, aborted: true, message: err.userMessage };
    }
    if (err instanceof DreamcodeError) {
      return { ok: false, aborted: false, error: err };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      aborted: false,
      error: new DreamcodeError("runtime", message),
    };
  }
}

function isTruthy(value: DreamValue): boolean {
  if (value === null || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function eq(a: DreamValue, b: DreamValue): boolean {
  if (isEntity(a) && isEntity(b)) return String(a.id) === String(b.id);
  return a === b;
}

function isEntity(v: DreamValue): v is DreamObject & { id: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof v.id === "string";
}

function toNumber(value: DreamValue, pos: SourcePos): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  throw new DreamcodeError("runtime", `Expected a number, got '${stringifyValue(value)}'`, pos);
}

export function stringifyValue(value: DreamValue): string {
  if (value === null) return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringifyValue).join(" ");
  if (typeof value === "object") {
    if (typeof value.mention === "string") return value.mention;
    if (typeof value.name === "string") return value.name;
    if (typeof value.id === "string") return value.id;
  }
  return "";
}

export function parseWaitMs(value: DreamValue | undefined, pos: SourcePos): number {
  if (typeof value === "number") {
    if (value < 0) throw new DreamcodeError("runtime", "Wait duration cannot be negative", pos);
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const match = trimmed.match(/^(\d+)([smhdw])$/i);
    if (!match) throw new DreamcodeError("runtime", `Invalid wait duration '${value}'`, pos);
    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return amount * (mult[unit] ?? 1000);
  }
  throw new DreamcodeError("runtime", "Wait duration must be a number or duration string", pos);
}

/** Parse duration strings for mod actions (same units as wait). */
export function parseDurationValue(value: DreamValue | undefined, pos: SourcePos): number {
  return parseWaitMs(value, pos);
}
