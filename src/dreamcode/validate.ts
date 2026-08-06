import { getActionDef, isKnownAction } from "./actions.js";
import { DreamcodeError } from "./errors.js";
import type { ActionArg, Expr, Program, Stmt } from "./types.js";

export function validateDreamcode(program: Program): void {
  for (const stmt of program.body) {
    validateStmt(stmt);
  }
}

function validateStmt(stmt: Stmt): void {
  switch (stmt.kind) {
    case "set":
      validateExpr(stmt.value);
      return;
    case "require":
      validateExpr(stmt.value);
      return;
    case "error":
      validateExpr(stmt.message);
      return;
    case "if":
      validateExpr(stmt.condition);
      for (const s of stmt.thenBody) validateStmt(s);
      for (const s of stmt.elseBody) validateStmt(s);
      return;
    case "action":
      validateActionCall(stmt.name, stmt.args, stmt.pos);
      return;
  }
}

function validateExpr(expr: Expr): void {
  switch (expr.kind) {
    case "literal":
    case "path":
      return;
    case "unary":
      validateExpr(expr.operand);
      return;
    case "binary":
      validateExpr(expr.left);
      validateExpr(expr.right);
      return;
    case "action":
      validateActionCall(expr.name, expr.args, expr.pos);
      return;
  }
}

function validateActionCall(
  name: string,
  args: ActionArg[],
  pos: { line: number; column: number },
): void {
  if (!isKnownAction(name)) {
    throw new DreamcodeError("validate", `Unknown action '${name}'`, pos);
  }
  const def = getActionDef(name)!;
  for (const arg of args) {
    validateExpr(arg.value);
  }

  let positionalCount = 0;
  const named = new Set<string>();
  let seenNamed = false;

  for (const arg of args) {
    if (arg.kind === "positional") {
      if (seenNamed) {
        throw new DreamcodeError("validate", `Positional args must come before named args in '${name}'`, pos);
      }
      positionalCount++;
      continue;
    }
    seenNamed = true;
    if (named.has(arg.name)) {
      throw new DreamcodeError("validate", `Duplicate named argument '${arg.name}' on '${name}'`, pos);
    }
    named.add(arg.name);
    const allowed = new Set([...def.positional.map((p) => p.name), ...def.named.map((p) => p.name)]);
    if (!allowed.has(arg.name)) {
      throw new DreamcodeError("validate", `Unknown argument '${arg.name}' on '${name}'`, pos);
    }
  }

  if (positionalCount > def.positional.length) {
    throw new DreamcodeError(
      "validate",
      `Action '${name}' takes at most ${def.positional.length} positional argument(s), got ${positionalCount}`,
      pos,
    );
  }

  for (let i = positionalCount; i < def.positional.length; i++) {
    const p = def.positional[i]!;
    if (p.required && !named.has(p.name)) {
      throw new DreamcodeError("validate", `Action '${name}' requires '${p.name}'`, pos);
    }
  }
  for (const p of def.named) {
    if (p.required && !named.has(p.name)) {
      const idx = def.positional.findIndex((x) => x.name === p.name);
      if (idx >= 0 && idx < positionalCount) continue;
      throw new DreamcodeError("validate", `Action '${name}' requires '${p.name}'`, pos);
    }
  }
}
