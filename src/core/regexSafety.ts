/**
 * Defense against catastrophic backtracking (ReDoS) in user-supplied regular
 * expressions. Several plugins (automod custom filters, autoreactions,
 * autoreplies, autothreads, custom events, and utility clean/search) let
 * server managers type an arbitrary regex that then runs against every
 * message. A pattern like `(a+)+$` is syntactically valid but can take
 * exponential time on an adversarial input — since Node's regex engine runs
 * synchronously on the main thread, one bad pattern hangs message handling
 * for every guild the bot is in, not just the guild that configured it.
 *
 * This is defense in depth, not one trick:
 *  1. `findCatastrophicRegexRisk` — a fast, synchronous static scan for the
 *     textbook shapes that cause exponential blowup (a repeated group whose
 *     own body can also repeat or branch over the same characters, e.g.
 *     `(a+)+`, `(a*)*`, `([a-z]+)*`, `(a|a)+`, `(a|ab)*`). This is what
 *     actually protects the hot path — `compileUserRegex` runs it on every
 *     pattern before compiling, so nothing dangerous is ever compiled, and
 *     patterns saved before this shipped stop matching the moment it does.
 *  2. `probeRegexTiming` — an empirical check used only when a pattern is
 *     being saved (a rare, deliberate, already-async action): it runs the
 *     compiled pattern against a short ladder of adversarial strings and
 *     rejects it if any step is unexpectedly slow. This catches shapes the
 *     static scan doesn't recognise as well as the classic nested-quantifier
 *     case.
 *  3. Length caps on both the pattern itself and the content tested against
 *     it, applied by callers (`MAX_USER_PATTERN_LENGTH`,
 *     `MAX_TESTED_CONTENT_LENGTH`) — bounds worst-case work regardless of
 *     what slips past 1 and 2.
 *
 * The static scan is deliberately conservative: some safe patterns that
 * happen to have a repeated group inside a repeated group (e.g.
 * `(?:[\w-]+\.)+[\w-]+`, safe because `.` can't appear inside `[\w-]+`) will
 * be rejected too. That's an accepted trade-off shared by every practical
 * ReDoS static analyzer — proving a pattern safe in general is undecidable,
 * so when in doubt this errs toward rejecting rather than risking a hang.
 */

export const MAX_USER_PATTERN_LENGTH = 200;
/** Discord's own message cap is 4000 (2000 without Nitro) — this just bounds worst case explicitly. */
export const MAX_TESTED_CONTENT_LENGTH = 4000;

type GroupFrame = {
  /** This group directly contains (or nested-propagated from) a `+`/`*`/`{n,}` on some subexpression. */
  hasRepeat: boolean;
  /** This group directly contains a top-level `|` alternation. */
  hasAlternation: boolean;
};

/** Returns the length of an unbounded/large-bound quantifier starting at `source[i]`, or 0 if none. */
function quantifierLengthAt(source: string, i: number): { length: number; unbounded: boolean } | null {
  const ch = source[i];
  if (ch === "+" || ch === "*") {
    // Lazy modifier `+?` / `*?` doesn't change the backtracking risk.
    const lazy = source[i + 1] === "?" ? 1 : 0;
    return { length: 1 + lazy, unbounded: true };
  }
  if (ch === "{") {
    const match = /^\{(\d+)?(,)?(\d+)?\}/.exec(source.slice(i));
    if (!match) return null;
    const [full, min, comma, max] = match;
    if (min === undefined && max === undefined) return null; // `{}` literal, not a quantifier
    const unbounded = Boolean(comma) && max === undefined;
    const largeBound = max !== undefined && Number(max) - Number(min ?? "0") > 20;
    const lazy = source[i + full.length] === "?" ? 1 : 0;
    return { length: full.length + lazy, unbounded: unbounded || largeBound };
  }
  return null;
}

/**
 * Heuristic catastrophic-backtracking detector — see module doc for what it
 * catches and why it's intentionally conservative. Returns a human-readable
 * reason when it finds a risky shape, or `null` when the pattern looks safe.
 */
export function findCatastrophicRegexRisk(source: string): string | null {
  const stack: GroupFrame[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === "\\") {
      i += 2;
      continue;
    }

    if (ch === "[") {
      // Character classes are literal — `+`, `*`, `(`, `)`, `|` inside one mean nothing
      // to the backtracker, so skip the whole class verbatim.
      i += 1;
      if (source[i] === "^") i += 1;
      if (source[i] === "]") i += 1; // a `]` right after `[`/`[^` is a literal member
      while (i < source.length && source[i] !== "]") {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }

    if (ch === "(") {
      stack.push({ hasRepeat: false, hasAlternation: false });
      i += 1;
      continue;
    }

    if (ch === ")") {
      const frame = stack.pop();
      i += 1;
      const quant = quantifierLengthAt(source, i);

      if (frame && quant?.unbounded && (frame.hasRepeat || frame.hasAlternation)) {
        return frame.hasAlternation
          ? "a repeated group contains branches that can match the same text more than one way"
          : "a repeated group contains its own repetition (e.g. `(a+)+`)";
      }

      if (quant) i += quant.length;

      // Propagate risk outward: a repeated (or alternating) subgroup makes its
      // parent group "contain repetition" too, so `((a+)+)+`-shaped nesting at
      // any depth is still caught when the outermost group closes.
      if (stack.length) {
        const parent = stack[stack.length - 1]!;
        if (quant || frame?.hasRepeat || frame?.hasAlternation) parent.hasRepeat = true;
      }
      continue;
    }

    if (ch === "|") {
      if (stack.length) stack[stack.length - 1]!.hasAlternation = true;
      i += 1;
      continue;
    }

    if (ch === "+" || ch === "*") {
      if (stack.length) stack[stack.length - 1]!.hasRepeat = true;
      i += 1;
      continue;
    }

    if (ch === "{") {
      const quant = quantifierLengthAt(source, i);
      if (quant) {
        if (stack.length) stack[stack.length - 1]!.hasRepeat = true;
        i += quant.length;
        continue;
      }
    }

    i += 1;
  }

  return null;
}

export type RegexValidationResult = { ok: true } | { ok: false; error: string };

/** Syntax + static-risk validation — synchronous, cheap enough for the hot path. */
export function validateRegexPatternSync(pattern: string, flags: string): RegexValidationResult {
  if (!pattern) return { ok: false, error: "Pattern is empty." };
  if (pattern.length > MAX_USER_PATTERN_LENGTH) {
    return { ok: false, error: `Pattern is too long (max ${MAX_USER_PATTERN_LENGTH} characters).` };
  }
  try {
    // eslint-disable-next-line no-new -- syntax check only
    new RegExp(pattern, flags);
  } catch {
    return { ok: false, error: "Not a valid regular expression." };
  }
  const risk = findCatastrophicRegexRisk(pattern);
  if (risk) {
    return {
      ok: false,
      error: `This pattern could hang the bot on certain messages (${risk}). Rewrite it to avoid a repeated group nested inside another repeated group.`,
    };
  }
  return { ok: true };
}

/** Adversarial input ladder — a run of one repeated character followed by one that
 * can never complete the match is the textbook trigger for catastrophic backtracking. */
const PROBE_LENGTHS = [8, 12, 16, 20, 24];
const PROBE_BUDGET_MS = 40;

/**
 * Empirically times the pattern against a short ladder of adversarial
 * strings. Only call this from an already-async, infrequent path (saving a
 * rule) — a genuinely catastrophic pattern *will* block the thread for the
 * duration of whichever probe step first exposes it, which is bounded by
 * `PROBE_LENGTHS`'s max but is not instant.
 */
export async function probeRegexTiming(pattern: string, flags: string): Promise<RegexValidationResult> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return { ok: false, error: "Not a valid regular expression." };
  }

  for (const n of PROBE_LENGTHS) {
    const probe = "a".repeat(n) + " ";
    const start = performance.now();
    try {
      re.test(probe);
    } catch {
      // A thrown error from .test() isn't a timing concern — ignore and keep probing.
    }
    const elapsed = performance.now() - start;
    if (elapsed > PROBE_BUDGET_MS) {
      return {
        ok: false,
        error: `This pattern is too slow on adversarial input (${elapsed.toFixed(0)}ms testing a ${n}-character probe) and was rejected to protect the bot.`,
      };
    }
    // Yield back to the event loop between probe steps so a borderline-slow
    // (but not rejected) pattern doesn't monopolize the thread in one burst.
    await new Promise((resolve) => setImmediate(resolve));
  }

  return { ok: true };
}

/**
 * Full save-time validation: syntax + static risk scan + empirical timing
 * probe. Use this wherever a user submits a regex pattern to be stored
 * (modals, slash command options, JSON config blobs) — never in the
 * per-message hot path, since the timing probe can itself take a moment.
 */
export async function validateRegexPatternForSave(pattern: string, flags: string): Promise<RegexValidationResult> {
  const sync = validateRegexPatternSync(pattern, flags);
  if (!sync.ok) return sync;
  return probeRegexTiming(pattern, flags);
}
