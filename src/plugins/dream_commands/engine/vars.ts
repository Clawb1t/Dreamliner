/**
 * Variables and {token} interpolation for custom commands.
 *
 * Two output modes:
 * - "message": text that ends up in a Discord message. Values that came from people (option
 *   text, form answers, nicknames, list items...) are escaped so they can't fake pings or masked
 *   links: @everyone/@here and <@&role> are broken with a zero-width space and [ ] are escaped.
 *   Values Dreamliner generated itself (mentions, ids, urls) are marked trusted and kept as is.
 *   Pings are still decided only by the message's allowedMentions, never by the text.
 * - "raw": data (channel names, comparisons, maths). Only control characters are stripped.
 *
 * Token grammar is linear: {key}, {key|fallback}, {random:1-100}, {timestamp:R}. No regex from users.
 */
import { LIMITS, type VarValue } from "./types.js";

export type VarStore = {
  values: Map<string, VarValue>;
  /** Keys whose values Dreamliner produced (mentions, ids, urls). */
  trusted: Set<string>;
};

export function newVarStore(): VarStore {
  return { values: new Map(), trusted: new Set() };
}

// Control characters except tab and newline, plus bidi overrides that can disguise text.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

export function stripControl(text: string): string {
  return text.replace(CONTROL_RE, "");
}

/** Escapes a person-provided value for message text. */
export function escapeForMessage(text: string): string {
  return text
    .replace(/@(everyone|here)/gi, "@​$1")
    .replace(/<@&/g, "<@​&")
    .replace(/<@!?(\d)/g, "<@​$1")
    .replace(/([[\]])/g, "\\$1");
}

function clampString(text: string, max: number = LIMITS.varLength): string {
  const clean = stripControl(text);
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Normalises any value to what a variable may hold (strings capped, lists capped). */
export function normalizeValue(value: unknown): VarValue {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, LIMITS.listItems).map((v) => clampString(String(v), 500));
  if (value === null || value === undefined) return "";
  return clampString(String(value));
}

export function setVar(store: VarStore, key: string, value: unknown, trusted = false): void {
  if (!store.values.has(key) && store.values.size >= LIMITS.vars) return;
  store.values.set(key, normalizeValue(value));
  if (trusted) store.trusted.add(key);
  else store.trusted.delete(key);
}

export function valueToText(value: VarValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  return String(value);
}

export type InterpolateOptions = {
  mode: "message" | "raw";
  now?: Date;
  rng?: () => number;
  /** Roots that are variables; unknown roots are left as typed (e.g. literal "{hello}"). */
  maxLength?: number;
};

const TOKEN_RE = /\{([a-z][a-z0-9_]{0,40}(?:[.:][a-z0-9_-]{1,40}){0,4})(?:\|([^{}\n]{0,100}))?\}/gi;

const DYNAMIC_ROOTS = new Set(["random", "time", "date", "timestamp"]);

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dynamicToken(key: string, now: Date, rng: () => number): string | null {
  const [root, arg] = key.split(":", 2) as [string, string | undefined];
  switch (root) {
    case "random": {
      const m = /^(-?\d{1,9})-(-?\d{1,9})$/.exec(arg ?? "1-100");
      if (!m) return null;
      let lo = Number(m[1]);
      let hi = Number(m[2]);
      if (lo > hi) [lo, hi] = [hi, lo];
      return String(lo + Math.floor(rng() * (hi - lo + 1)));
    }
    case "time":
      return `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
    case "date":
      return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    case "timestamp": {
      const style = arg && /^[tTdDfFR]$/.test(arg) ? arg : "f";
      return `<t:${Math.floor(now.getTime() / 1000)}:${style}>`;
    }
    default:
      return null;
  }
}

/** Whether a key looks like one of ours (so a missing value renders empty, not the raw token). */
export function isVariableRoot(root: string, store: VarStore): boolean {
  if (DYNAMIC_ROOTS.has(root)) return true;
  if (["user", "server", "channel", "option", "var", "loop", "form", "press", "runs", "command"].includes(root)) return true;
  for (const key of store.values.keys()) {
    if (key === root || key.startsWith(`${root}.`)) return true;
  }
  return false;
}

/** Replaces {tokens} with variable values. Never throws. */
export function interpolate(template: string, store: VarStore, options: InterpolateOptions): string {
  if (!template) return "";
  const now = options.now ?? new Date();
  const rng = options.rng ?? Math.random;
  const source = template.length > 8000 ? template.slice(0, 8000) : template;
  const out = source.replace(TOKEN_RE, (whole, rawKey: string, fallback: string | undefined) => {
    const key = rawKey.toLowerCase();
    const dynamic = dynamicToken(key, now, rng);
    if (dynamic !== null) return dynamic;
    const root = key.split(/[.:]/, 1)[0]!;
    const value = store.values.get(key);
    let text = valueToText(value);
    if (value === undefined || text === "") {
      if (fallback !== undefined) return options.mode === "message" ? escapeForMessage(stripControl(fallback)) : stripControl(fallback);
      return isVariableRoot(root, store) ? "" : whole;
    }
    if (options.mode === "message" && !store.trusted.has(key)) text = escapeForMessage(text);
    return text;
  });
  const clean = stripControl(out);
  return options.maxLength && clean.length > options.maxLength ? clean.slice(0, options.maxLength) : clean;
}

/** Every {token} key referenced in a string (lowercased, without fallback). */
export function referencedKeys(template: string): string[] {
  const keys: string[] = [];
  for (const m of template.matchAll(TOKEN_RE)) keys.push(m[1]!.toLowerCase());
  return keys;
}

/** Pulls a Discord snowflake out of "123", "<@123>", "<@!123>", "<#123>", "<@&123>". */
export function extractSnowflake(text: string): string | null {
  const trimmed = text.trim();
  const m = /^(?:<(?:@[!&]?|#))?(\d{15,22})>?$/.exec(trimmed);
  return m ? m[1]! : null;
}

export function toNumber(value: VarValue | string | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined || Array.isArray(value)) return null;
  const n = Number(String(value).trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
