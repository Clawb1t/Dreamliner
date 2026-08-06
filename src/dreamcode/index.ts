import { DreamcodeError } from "./errors.js";
import { interpretDreamcode, type InterpretOptions, type InterpretResult } from "./interpret.js";
import { parseDreamcode } from "./parser.js";
import type { Program } from "./types.js";
import { validateDreamcode } from "./validate.js";

export { ACTION_DEFS, ACTION_MAP, actionsByCategory, getActionDef, isKnownAction } from "./actions.js";
export { DreamcodeAbort, DreamcodeError } from "./errors.js";
export {
  interpretDreamcode,
  parseDurationValue,
  parseWaitMs,
  stringifyValue,
  type InterpretOptions,
  type InterpretResult,
} from "./interpret.js";
export { parseDreamcode } from "./parser.js";
export { validateDreamcode } from "./validate.js";
export type {
  ActionCategory,
  ActionDef,
  ActionHost,
  ActionParamDef,
  BoundActionArgs,
  DreamObject,
  DreamTriggerKind,
  DreamValue,
  InterpretLimits,
  Program,
  SlashArgDef,
  SlashArgType,
  SlashProps,
  SourcePos,
  Stmt,
} from "./types.js";
export { DEFAULT_LIMITS, EMPTY_SLASH_PROPS, SLASH_ARG_TYPES } from "./types.js";

/** Parse and validate source. Throws DreamcodeError on failure. */
export function compileDreamcode(source: string): Program {
  const program = parseDreamcode(source);
  validateDreamcode(program);
  return program;
}

/** Compile then interpret. */
export async function runDreamcode(source: string, options: InterpretOptions): Promise<InterpretResult> {
  try {
    const program = compileDreamcode(source);
    return interpretDreamcode(program, options);
  } catch (err) {
    if (err instanceof DreamcodeError) {
      return { ok: false, aborted: false, error: err };
    }
    throw err;
  }
}
