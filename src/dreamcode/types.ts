/** Dreamcode AST and runtime value types. */

export type SourcePos = { line: number; column: number };

export type Expr =
  | { kind: "literal"; value: string | number | boolean | null; pos: SourcePos }
  | { kind: "path"; parts: string[]; pos: SourcePos }
  | { kind: "unary"; op: "not"; operand: Expr; pos: SourcePos }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; pos: SourcePos }
  | { kind: "action"; name: string; args: ActionArg[]; pos: SourcePos };

export type BinaryOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export type ActionArg =
  | { kind: "positional"; value: Expr }
  | { kind: "named"; name: string; value: Expr };

export type Stmt =
  | { kind: "set"; name: string; value: Expr; pos: SourcePos }
  | { kind: "require"; value: Expr; pos: SourcePos }
  | { kind: "error"; message: Expr; pos: SourcePos }
  | { kind: "if"; condition: Expr; thenBody: Stmt[]; elseBody: Stmt[]; pos: SourcePos }
  | { kind: "action"; name: string; args: ActionArg[]; pos: SourcePos };

/** How the command is invoked — declared with `@slash` at the top of the file. */
export type DreamTriggerKind = "slash";

/** Discord slash option types supported by `@slash arg …`. */
export type SlashArgType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "user"
  | "channel"
  | "role"
  | "mentionable"
  | "attachment";

export type SlashArgDef = {
  type: SlashArgType;
  name: string;
  description: string;
  required?: boolean;
};

/** Slash-command metadata declared with `@slash …` at the top of a script. */
export type SlashProps = {
  /** Omit Discord options entirely (no legacy `args` string either). */
  noargs?: boolean;
  /** Defer/reply ephemerally (only the invoker sees responses from `reply`). */
  ephemeral?: boolean;
  /** Discord slash command description (max 100 chars). */
  description?: string;
  /** Typed Discord slash options (`@slash arg <type> <name> …`). */
  args: SlashArgDef[];
};

export type Program = {
  body: Stmt[];
  /** Set by `@slash` directives. Required for `/command create`. */
  trigger: DreamTriggerKind | null;
  slash: SlashProps;
};

export const EMPTY_SLASH_PROPS: SlashProps = { args: [] };

export const SLASH_ARG_TYPES: readonly SlashArgType[] = [
  "string",
  "integer",
  "number",
  "boolean",
  "user",
  "channel",
  "role",
  "mentionable",
  "attachment",
] as const;

/** Runtime values available inside Dreamcode. */
export type DreamValue =
  | null
  | boolean
  | number
  | string
  | DreamObject
  | DreamValue[];

export type DreamObject = {
  __type?: string;
  [key: string]: DreamValue | undefined;
};

export type ActionParamDef = {
  name: string;
  /** When true, this named param is required (after positional binding). */
  required?: boolean;
  description: string;
  /** Editor hint for website form fields. */
  type?:
    | "string"
    | "number"
    | "boolean"
    | "user"
    | "role"
    | "channel"
    | "message"
    | "emoji"
    | "duration"
    | "any";
};

export type ActionCategory =
  | "messaging"
  | "moderation"
  | "roles"
  | "voice"
  | "channel"
  | "cases"
  | "tags"
  | "counters"
  | "reminders"
  | "posts"
  | "logging"
  | "lookup"
  | "utility"
  | "control";

export type ActionDef = {
  key: string;
  category: ActionCategory;
  description: string;
  /** Ordered positional parameters (bound left-to-right before named args). */
  positional: ActionParamDef[];
  named: ActionParamDef[];
  /** What the action returns (null/void if omitted). Documented for the website editor. */
  returns?: string;
  /** True when the action mutates Discord/DB state. */
  mutates?: boolean;
};

export type BoundActionArgs = Record<string, DreamValue>;

export type ActionHost = {
  run(action: string, args: BoundActionArgs, pos: SourcePos): Promise<DreamValue>;
};

export type InterpretLimits = {
  maxSteps: number;
  maxDurationMs: number;
  maxWaitMs: number;
};

export const DEFAULT_LIMITS: InterpretLimits = {
  maxSteps: 500,
  maxDurationMs: 15_000,
  maxWaitMs: 10_000,
};
