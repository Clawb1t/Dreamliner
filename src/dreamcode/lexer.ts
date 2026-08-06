import { DreamcodeError } from "./errors.js";
import type { SourcePos } from "./types.js";

export type TokenType =
  | "ident"
  | "number"
  | "string"
  | "duration"
  | "keyword"
  | "op"
  | "colon"
  | "dot"
  | "at"
  | "newline"
  | "eof";

export type Token = {
  type: TokenType;
  value: string;
  pos: SourcePos;
};

const KEYWORDS = new Set(["set", "if", "then", "else", "end", "require", "error", "not", "and", "or", "true", "false", "null"]);

const OPS = ["==", "!=", "<=", ">=", "<", ">", "="];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const pos = (): SourcePos => ({ line, column });

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
    }
  };

  const peek = (offset = 0) => source[i + offset] ?? "";

  while (i < source.length) {
    const ch = peek();

    if (ch === "\r") {
      advance();
      continue;
    }

    if (ch === "\n") {
      tokens.push({ type: "newline", value: "\n", pos: pos() });
      advance();
      continue;
    }

    if (ch === " " || ch === "\t") {
      advance();
      continue;
    }

    if (ch === "#") {
      while (i < source.length && peek() !== "\n") advance();
      continue;
    }

    if (ch === '"') {
      const start = pos();
      advance();
      let value = "";
      while (i < source.length && peek() !== '"') {
        if (peek() === "\\") {
          advance();
          const esc = peek();
          if (esc === "n") value += "\n";
          else if (esc === "t") value += "\t";
          else if (esc === '"' || esc === "\\") value += esc;
          else value += esc;
          advance();
          continue;
        }
        if (peek() === "\n") {
          throw new DreamcodeError("parse", "Unterminated string", start);
        }
        value += peek();
        advance();
      }
      if (peek() !== '"') throw new DreamcodeError("parse", "Unterminated string", start);
      advance();
      tokens.push({ type: "string", value, pos: start });
      continue;
    }

    let matchedOp = "";
    for (const op of OPS) {
      if (source.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      tokens.push({ type: "op", value: matchedOp, pos: pos() });
      advance(matchedOp.length);
      continue;
    }

    if (ch === ":") {
      tokens.push({ type: "colon", value: ":", pos: pos() });
      advance();
      continue;
    }

    if (ch === ".") {
      tokens.push({ type: "dot", value: ".", pos: pos() });
      advance();
      continue;
    }

    if (ch === "@") {
      tokens.push({ type: "at", value: "@", pos: pos() });
      advance();
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = pos();
      let raw = "";
      while (/[0-9]/.test(peek())) {
        raw += peek();
        advance();
      }
      if (/[smhdw]/i.test(peek()) && !/[a-zA-Z_]/.test(peek(1))) {
        raw += peek();
        advance();
        tokens.push({ type: "duration", value: raw, pos: start });
      } else if (/[a-zA-Z_]/.test(peek())) {
        throw new DreamcodeError("parse", `Invalid number literal near '${raw}${peek()}'`, start);
      } else {
        tokens.push({ type: "number", value: raw, pos: start });
      }
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = pos();
      let raw = "";
      while (/[a-zA-Z0-9_]/.test(peek())) {
        raw += peek();
        advance();
      }
      // duration starting with number already handled; allow ident.duration style separately
      const lower = raw.toLowerCase();
      if (KEYWORDS.has(lower)) {
        tokens.push({ type: "keyword", value: lower, pos: start });
      } else {
        tokens.push({ type: "ident", value: raw, pos: start });
      }
      continue;
    }

    throw new DreamcodeError("parse", `Unexpected character '${ch}'`, pos());
  }

  tokens.push({ type: "eof", value: "", pos: pos() });
  return tokens;
}
