/**
 * Small dependency-free colored console logger.
 *
 * Every subsystem gets its own scoped logger via `getLogger("scope")`, which tags every
 * line with a timestamp, a colored level, and a colored `[scope]` tag (stable per scope,
 * via a hash into a fixed palette) so different parts of the bot are visually distinct in
 * the console — e.g. `[bridge]` requests, `[automod]` actions, `[scheduler]` fires.
 *
 * Colors are skipped automatically when NO_COLOR is set or stdout isn't a TTY.
 */

type LogLevel = "debug" | "info" | "success" | "warn" | "error" | "http";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const colorEnabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout && process.stdout.isTTY);
})();

function paint(code: string, text: string): string {
  return colorEnabled ? `${code}${text}${RESET}` : text;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gray
  info: "\x1b[36m", // cyan
  success: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  http: "\x1b[35m", // magenta — used for bridge/site fetch traffic
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  success: "OK",
  warn: "WARN",
  error: "ERROR",
  http: "HTTP",
};

// Palette for per-scope tags. Deliberately excludes plain red/yellow/green so scope color
// never gets confused with a level color.
const SCOPE_PALETTE = [
  "\x1b[34m", // blue
  "\x1b[35m", // magenta
  "\x1b[36m", // cyan
  "\x1b[94m", // bright blue
  "\x1b[95m", // bright magenta
  "\x1b[96m", // bright cyan
  "\x1b[92m", // bright green
  "\x1b[97m", // bright white
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function scopeColor(scope: string): string {
  return SCOPE_PALETTE[hashString(scope) % SCOPE_PALETTE.length];
}

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function write(level: LogLevel, scope: string, args: unknown[]): void {
  const prefix = [
    paint(DIM, timestamp()),
    paint(LEVEL_COLOR[level] + BOLD, LEVEL_LABEL[level].padEnd(5)),
    paint(scopeColor(scope), `[${scope}]`),
  ].join(" ");
  const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  target(prefix, ...args);
}

export type Logger = {
  /** Verbose diagnostic detail — hidden by default in production if you choose to gate it. */
  debug(...args: unknown[]): void;
  /** Normal operational messages — what the bot is doing. */
  info(...args: unknown[]): void;
  /** A notable positive outcome (boot complete, sync finished, etc). */
  success(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Inbound/outbound HTTP traffic — e.g. the dashboard site hitting the bridge. */
  http(...args: unknown[]): void;
};

const cache = new Map<string, Logger>();

/** Get (or create) a colored logger tagged with `scope`, e.g. getLogger("bridge"). */
export function getLogger(scope: string): Logger {
  const cached = cache.get(scope);
  if (cached) return cached;
  const instance: Logger = {
    debug: (...args) => write("debug", scope, args),
    info: (...args) => write("info", scope, args),
    success: (...args) => write("success", scope, args),
    warn: (...args) => write("warn", scope, args),
    error: (...args) => write("error", scope, args),
    http: (...args) => write("http", scope, args),
  };
  cache.set(scope, instance);
  return instance;
}

/** General-purpose logger for ad-hoc use. Prefer a scoped logger via getLogger() when possible. */
export const logger = getLogger("bot");
