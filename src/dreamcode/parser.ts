import { isKnownAction } from "./actions.js";
import { DreamcodeError } from "./errors.js";
import { tokenize, type Token } from "./lexer.js";
import type {
  ActionArg,
  BinaryOp,
  DreamTriggerKind,
  Expr,
  Program,
  SlashArgDef,
  SlashArgType,
  SlashProps,
  SourcePos,
  Stmt,
} from "./types.js";
import { SLASH_ARG_TYPES } from "./types.js";

const SLASH_FLAGS = new Set(["noargs", "ephemeral"]);
const SLASH_ARG_TYPE_SET = new Set<string>(SLASH_ARG_TYPES);
const OPTION_NAME_RE = /^[a-z0-9_]{1,32}$/;
const MAX_SLASH_ARGS = 25;

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
    const { trigger, slash } = this.parseDirectiveBlock();
    const body: Stmt[] = [];
    while (!this.check("eof")) {
      body.push(this.parseStmt());
      this.skipNewlines();
    }
    return { body, trigger, slash };
  }

  /**
   * Top-of-file directives:
   *   @slash
   *   @slash noargs | ephemeral | description "…" | arg <type> <name> …
   */
  private parseDirectiveBlock(): { trigger: DreamTriggerKind | null; slash: SlashProps } {
    let trigger: DreamTriggerKind | null = null;
    const slash: SlashProps = { args: [] };
    const seenArgNames = new Set<string>();

    while (this.check("at")) {
      const at = this.advance();
      const tag = this.expect("ident", "Expected `slash` after `@`");
      const tagName = tag.value.toLowerCase();

      if (tagName === "prefix") {
        throw new DreamcodeError(
          "parse",
          "@prefix is no longer supported — use @slash (Dreamcode commands are slash-only)",
          tag.pos
        );
      }

      if (tagName !== "slash") {
        throw new DreamcodeError(
          "parse",
          `Unknown directive @${tag.value} (use @slash)`,
          tag.pos
        );
      }

      trigger = "slash";

      // Bare `@slash` — just declares slash trigger type.
      if (this.atLineEnd()) {
        this.expectLineEnd();
        this.skipNewlines();
        continue;
      }

      if (!this.check("ident") && !this.check("keyword")) {
        throw new DreamcodeError("parse", "Expected a slash property after @slash", at.pos);
      }
      const propTok = this.advance();
      const prop = propTok.value.toLowerCase();

      if (prop === "description") {
        const s = this.expect("string", "Expected a string after @slash description");
        const text = s.value.trim();
        if (!text) {
          throw new DreamcodeError("parse", "Slash description cannot be empty", s.pos);
        }
        if (text.length > 100) {
          throw new DreamcodeError(
            "parse",
            "Slash description must be 100 characters or fewer",
            s.pos
          );
        }
        slash.description = text;
      } else if (prop === "arg") {
        const arg = this.parseSlashArg(propTok.pos);
        if (seenArgNames.has(arg.name)) {
          throw new DreamcodeError(
            "parse",
            `Duplicate slash arg name '${arg.name}'`,
            propTok.pos
          );
        }
        if (slash.args.length >= MAX_SLASH_ARGS) {
          throw new DreamcodeError(
            "parse",
            `At most ${MAX_SLASH_ARGS} slash args are allowed`,
            propTok.pos
          );
        }
        if (slash.noargs) {
          throw new DreamcodeError(
            "parse",
            "Cannot combine @slash noargs with @slash arg",
            propTok.pos
          );
        }
        seenArgNames.add(arg.name);
        slash.args.push(arg);
      } else if (SLASH_FLAGS.has(prop)) {
        if (prop === "noargs") {
          if (slash.args.length > 0) {
            throw new DreamcodeError(
              "parse",
              "Cannot combine @slash noargs with @slash arg",
              propTok.pos
            );
          }
          slash.noargs = true;
        }
        if (prop === "ephemeral") slash.ephemeral = true;
      } else {
        throw new DreamcodeError(
          "parse",
          `Unknown slash property '${propTok.value}' (use noargs, ephemeral, description, or arg)`,
          propTok.pos
        );
      }
      this.expectLineEnd();
      this.skipNewlines();
    }

    return { trigger, slash };
  }

  /** `@slash arg <type> <name> ["description"] [required]` */
  private parseSlashArg(_pos: SourcePos): SlashArgDef {
    const typeTok = this.expect("ident", "Expected arg type after @slash arg");
    const typeName = typeTok.value.toLowerCase();
    if (!SLASH_ARG_TYPE_SET.has(typeName)) {
      throw new DreamcodeError(
        "parse",
        `Unknown slash arg type '${typeTok.value}' (use ${SLASH_ARG_TYPES.join(", ")})`,
        typeTok.pos
      );
    }
    const nameTok = this.expect("ident", "Expected arg name after type");
    const name = nameTok.value.toLowerCase();
    if (!OPTION_NAME_RE.test(name)) {
      throw new DreamcodeError(
        "parse",
        "Slash arg name must be 1–32 characters: lowercase letters, numbers, underscores",
        nameTok.pos
      );
    }
    if (name === "args") {
      throw new DreamcodeError(
        "parse",
        "Slash arg name 'args' is reserved; choose another name",
        nameTok.pos
      );
    }

    let description = name;
    let required = false;
    if (this.check("string")) {
      const s = this.advance();
      const text = s.value.trim();
      if (!text) {
        throw new DreamcodeError("parse", "Slash arg description cannot be empty", s.pos);
      }
      if (text.length > 100) {
        throw new DreamcodeError(
          "parse",
          "Slash arg description must be 100 characters or fewer",
          s.pos
        );
      }
      description = text;
    }
    if (this.check("ident") || this.check("keyword")) {
      const t = this.peek();
      if (t.value.toLowerCase() === "required") {
        this.advance();
        required = true;
      } else {
        throw new DreamcodeError(
          "parse",
          `Unexpected '${t.value}' after slash arg (optional: description string, then required)`,
          t.pos
        );
      }
    }

    return {
      type: typeName as SlashArgType,
      name,
      description,
      required,
    };
  }

  private parseStmt(): Stmt {
    if (this.check("at")) {
      const t = this.peek();
      throw new DreamcodeError(
        "parse",
        "@slash directives must appear at the top of the script",
        t.pos
      );
    }
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
