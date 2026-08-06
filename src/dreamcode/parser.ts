import { isKnownAction } from "./actions.js";
import { DreamcodeError } from "./errors.js";
import { tokenize, type Token } from "./lexer.js";
import type { ActionArg, BinaryOp, Expr, Program, SourcePos, Stmt } from "./types.js";

export function parseDreamcode(source: string): Program {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parseProgram();
}

class Parser {
  private i = 0;

  constructor(private tokens: Token[]) {}

  parseProgram(): Program {
    this.skipNewlines();
    const body: Stmt[] = [];
    while (!this.check("eof")) {
      body.push(this.parseStmt());
      this.skipNewlines();
    }
    return { body };
  }

  private parseStmt(): Stmt {
    if (this.check("keyword", "set")) return this.parseSet();
    if (this.check("keyword", "if")) return this.parseIf();
    if (this.check("keyword", "require")) return this.parseRequire();
    if (this.check("keyword", "error")) return this.parseError();
    if (this.check("ident")) return this.parseActionStmt();
    const t = this.peek();
    throw new DreamcodeError("parse", `Unexpected token '${t.value || t.type}'`, t.pos);
  }

  private parseSet(): Stmt {
    const pos = this.advance().pos;
    const nameTok = this.expect("ident", "Expected variable name after set");
    this.expectOp("=");
    const value = this.parseRhs();
    this.expectLineEnd();
    return { kind: "set", name: nameTok.value, value, pos };
  }

  /** RHS of set / values that may be an action call or expression. */
  private parseRhs(): Expr {
    if (this.check("ident") && isKnownAction(this.peek().value) && this.looksLikeActionCall()) {
      return this.parseActionExpr();
    }
    return this.parseExpr();
  }

  /**
   * True when the known-action ident is followed by args, or stands alone as a no-arg call,
   * rather than starting a path like `get_member.foo` (invalid) or being followed by a comparison.
   * `set x = get_member arg.1` → action
   * `set x = invoker` → path (invoker is not an action)
   * `if has_role invoker role then` → handled via parseExpr in if which uses parsePrimary only…
   */
  private looksLikeActionCall(): boolean {
    const next = this.peekNext();
    if (!next || next.type === "newline" || next.type === "eof") return true;
    if (next.type === "dot") return false;
    if (next.type === "op") return false;
    if (next.type === "keyword" && (next.value === "and" || next.value === "or" || next.value === "then")) return false;
    return true;
  }

  private parseRequire(): Stmt {
    const pos = this.advance().pos;
    const value = this.parseRhs();
    this.expectLineEnd();
    return { kind: "require", value, pos };
  }

  private parseError(): Stmt {
    const pos = this.advance().pos;
    const message = this.parseExpr();
    this.expectLineEnd();
    return { kind: "error", message, pos };
  }

  private parseIf(): Stmt {
    const pos = this.advance().pos;
    const condition = this.parseCondition();
    if (!this.check("keyword", "then")) {
      throw new DreamcodeError("parse", "Expected 'then' after if condition", this.peek().pos);
    }
    this.advance();
    this.expectLineEnd();
    this.skipNewlines();

    const thenBody: Stmt[] = [];
    while (!this.check("keyword", "else") && !this.check("keyword", "end") && !this.check("eof")) {
      thenBody.push(this.parseStmt());
      this.skipNewlines();
    }

    let elseBody: Stmt[] = [];
    if (this.check("keyword", "else")) {
      this.advance();
      this.expectLineEnd();
      this.skipNewlines();
      while (!this.check("keyword", "end") && !this.check("eof")) {
        elseBody.push(this.parseStmt());
        this.skipNewlines();
      }
    }

    if (!this.check("keyword", "end")) {
      throw new DreamcodeError("parse", "Expected 'end' to close if", this.peek().pos);
    }
    this.advance();
    this.expectLineEnd();
    return { kind: "if", condition, thenBody, elseBody, pos };
  }

  /** Condition may include action calls: `if has_role invoker role then` */
  private parseCondition(): Expr {
    if (this.check("ident") && isKnownAction(this.peek().value) && this.looksLikeActionCall()) {
      const action = this.parseActionExprUntil(["then"]);
      // Allow `if has_role … == true then` — if next is comparison op, wrap
      const opTok = this.peek();
      if (opTok.type === "op" && opTok.value !== "=" && ["==", "!=", "<", "<=", ">", ">="].includes(opTok.value)) {
        this.advance();
        const right = this.parsePrimary();
        return { kind: "binary", op: opTok.value as BinaryOp, left: action, right, pos: opTok.pos };
      }
      // and/or chains after action
      return this.parseLogicAfter(action);
    }
    return this.parseExpr();
  }

  private parseLogicAfter(left: Expr): Expr {
    let current = left;
    while (this.check("keyword", "and") || this.check("keyword", "or")) {
      const op = this.peek().value as "and" | "or";
      const pos = this.advance().pos;
      const right = this.parseNot();
      current = { kind: "binary", op, left: current, right, pos };
    }
    return current;
  }

  private parseActionStmt(): Stmt {
    const expr = this.parseActionExpr();
    this.expectLineEnd();
    return { kind: "action", name: expr.name, args: expr.args, pos: expr.pos };
  }

  private parseActionExpr(stopKeywords: string[] = []): Extract<Expr, { kind: "action" }> {
    return this.parseActionExprUntil(stopKeywords);
  }

  private parseActionExprUntil(stopKeywords: string[]): Extract<Expr, { kind: "action" }> {
    const nameTok = this.advance();
    const pos = nameTok.pos;
    const args: ActionArg[] = [];

    while (!this.atLineEnd() && !(this.check("keyword") && stopKeywords.includes(this.peek().value))) {
      if (this.check("keyword", "and") || this.check("keyword", "or") || this.check("keyword", "then")) break;
      if (this.check("op") && this.peek().value !== "=") break;

      if (this.check("ident") && this.peekNext()?.type === "colon") {
        const name = this.advance().value;
        this.advance();
        const value = this.parsePrimary();
        args.push({ kind: "named", name: name.toLowerCase(), value });
        continue;
      }
      const value = this.parsePrimary();
      args.push({ kind: "positional", value });
    }

    return { kind: "action", name: nameTok.value.toLowerCase(), args, pos };
  }

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.check("keyword", "or")) {
      const pos = this.advance().pos;
      const right = this.parseAnd();
      left = { kind: "binary", op: "or", left, right, pos };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.check("keyword", "and")) {
      const pos = this.advance().pos;
      const right = this.parseNot();
      left = { kind: "binary", op: "and", left, right, pos };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.check("keyword", "not")) {
      const pos = this.advance().pos;
      const operand = this.parseNot();
      return { kind: "unary", op: "not", operand, pos };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseValue();
    const opTok = this.peek();
    if (opTok.type === "op" && opTok.value !== "=") {
      const op = opTok.value as BinaryOp;
      if (!["==", "!=", "<", "<=", ">", ">="].includes(op)) {
        return left;
      }
      this.advance();
      const right = this.parseValue();
      return { kind: "binary", op, left, right, pos: opTok.pos };
    }
    return left;
  }

  private parseValue(): Expr {
    if (this.check("ident") && isKnownAction(this.peek().value) && this.looksLikeActionCall()) {
      return this.parseActionExpr();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.type === "string") {
      this.advance();
      return { kind: "literal", value: t.value, pos: t.pos };
    }
    if (t.type === "number") {
      this.advance();
      return { kind: "literal", value: Number(t.value), pos: t.pos };
    }
    if (t.type === "duration") {
      this.advance();
      return { kind: "literal", value: t.value, pos: t.pos };
    }
    if (t.type === "keyword" && (t.value === "true" || t.value === "false" || t.value === "null")) {
      this.advance();
      const value = t.value === "null" ? null : t.value === "true";
      return { kind: "literal", value, pos: t.pos };
    }
    if (t.type === "ident") {
      return this.parsePath();
    }

    throw new DreamcodeError("parse", `Expected expression, got '${t.value || t.type}'`, t.pos);
  }

  private parsePath(): Expr {
    const first = this.expect("ident", "Expected identifier");
    const parts = [first.value];
    while (this.check("dot")) {
      this.advance();
      const next = this.peek();
      if (next.type === "ident" || next.type === "number" || next.type === "keyword") {
        parts.push(this.advance().value);
        continue;
      }
      throw new DreamcodeError("parse", "Expected property name after '.'", next.pos);
    }
    return { kind: "path", parts, pos: first.pos };
  }

  private peek(): Token {
    return this.tokens[this.i] ?? this.tokens[this.tokens.length - 1]!;
  }

  private peekNext(): Token | undefined {
    return this.tokens[this.i + 1];
  }

  private advance(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.i++;
    return t;
  }

  private check(type: Token["type"], value?: string): boolean {
    const t = this.peek();
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }

  private expect(type: Token["type"], message: string): Token {
    if (!this.check(type)) {
      throw new DreamcodeError("parse", message, this.peek().pos);
    }
    return this.advance();
  }

  private expectOp(value: string): void {
    const t = this.peek();
    if (t.type !== "op" || t.value !== value) {
      throw new DreamcodeError("parse", `Expected '${value}'`, t.pos);
    }
    this.advance();
  }

  private atLineEnd(): boolean {
    return this.check("newline") || this.check("eof");
  }

  private expectLineEnd(): void {
    if (this.check("newline") || this.check("eof")) return;
    throw new DreamcodeError("parse", "Expected end of line", this.peek().pos);
  }

  private skipNewlines(): void {
    while (this.check("newline")) this.advance();
  }
}

export type { SourcePos };
