/**
 * Tiny recursive-descent arithmetic evaluator for counting messages like "12+3" or "(4+4)*2".
 * Deliberately hand-rolled instead of Function()/eval(), since this only ever runs on untrusted
 * message content. Supports + - * / and parentheses over integers/decimals; returns null for
 * anything that isn't a clean, fully-consumed arithmetic expression (including division by zero
 * or a non-finite result).
 */
export function safeEvaluateExpression(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed || !/^[0-9+\-*/().\s]+$/.test(trimmed)) return null;

  let pos = 0;

  function peek(): string | undefined {
    return trimmed[pos];
  }

  function skipSpace(): void {
    while (peek() === " ") pos++;
  }

  function parseNumber(): number | null {
    skipSpace();
    const start = pos;
    while (pos < trimmed.length && /[0-9.]/.test(trimmed[pos]!)) pos++;
    if (pos === start) return null;
    const text = trimmed.slice(start, pos);
    if ((text.match(/\./g) ?? []).length > 1) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  function parseUnary(): number | null {
    skipSpace();
    if (peek() === "-") {
      pos++;
      const value = parseUnary();
      return value === null ? null : -value;
    }
    if (peek() === "+") {
      pos++;
      return parseUnary();
    }
    return parseAtom();
  }

  function parseAtom(): number | null {
    skipSpace();
    if (peek() === "(") {
      pos++;
      const value = parseExpression();
      skipSpace();
      if (peek() !== ")") return null;
      pos++;
      return value;
    }
    return parseNumber();
  }

  function parseTerm(): number | null {
    let value = parseUnary();
    if (value === null) return null;
    for (;;) {
      skipSpace();
      const op = peek();
      if (op !== "*" && op !== "/") break;
      pos++;
      const rhs = parseUnary();
      if (rhs === null) return null;
      if (op === "*") {
        value *= rhs;
      } else {
        if (rhs === 0) return null;
        value /= rhs;
      }
    }
    return value;
  }

  function parseExpression(): number | null {
    let value = parseTerm();
    if (value === null) return null;
    for (;;) {
      skipSpace();
      const op = peek();
      if (op !== "+" && op !== "-") break;
      pos++;
      const rhs = parseTerm();
      if (rhs === null) return null;
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = parseExpression();
  skipSpace();
  if (result === null || pos !== trimmed.length || !Number.isFinite(result)) return null;
  return result;
}
