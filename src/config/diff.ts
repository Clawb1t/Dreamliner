import { deepEqual } from "./validator.js";

export type ConfigChange = {
  path: string;
  before: unknown;
  after: unknown;
};

const MAX_VALUE_CHARS = 96;
const DEFAULT_MAX_CHANGES = 40;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  if (value === null) return "null";
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    const shown = compact.length > MAX_VALUE_CHARS ? `${compact.slice(0, MAX_VALUE_CHARS - 1)}…` : compact;
    return shown.length ? `\`${shown.replace(/`/g, "'")}\`` : "`(empty)`";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `\`${String(value)}\``;
  }
  try {
    const json = JSON.stringify(value);
    if (json == null) return "`(unknown)`";
    const shown = json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS - 1)}…` : json;
    return `\`${shown.replace(/`/g, "'")}\``;
  } catch {
    return "`(complex)`";
  }
}

function walkDiff(before: unknown, after: unknown, path: string, out: ConfigChange[]): void {
  if (deepEqual(before, after)) return;

  const bothObjects = isPlainObject(before) && isPlainObject(after);
  const bothArrays = Array.isArray(before) && Array.isArray(after);

  // Treat arrays as atomic values so logs stay readable.
  if (bothArrays || !bothObjects) {
    out.push({ path: path || "(root)", before, after });
    return;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const nextPath = path ? `${path}.${key}` : key;
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
    if (!hasBefore) {
      out.push({ path: nextPath, before: undefined, after: after[key] });
      continue;
    }
    if (!hasAfter) {
      out.push({ path: nextPath, before: before[key], after: undefined });
      continue;
    }
    walkDiff(before[key], after[key], nextPath, out);
  }
}

/** Deep-diff two config objects into dotted path changes. */
export function diffConfigValues(before: unknown, after: unknown): ConfigChange[] {
  const out: ConfigChange[] = [];
  walkDiff(before, after, "", out);
  return out;
}

/** Human-readable lines for Discord + dashboard log UIs (`path: old → new`). */
export function formatConfigChangeLines(
  changes: ConfigChange[],
  options?: { max?: number },
): string[] {
  const max = options?.max ?? DEFAULT_MAX_CHANGES;
  const lines = changes.slice(0, max).map((change) => {
    const from = formatValue(change.before);
    const to = formatValue(change.after);
    if (change.before === undefined) return `${change.path}: set to ${to}`;
    if (change.after === undefined) return `${change.path}: removed (was ${from})`;
    return `${change.path}: ${from} → ${to}`;
  });
  const remaining = changes.length - lines.length;
  if (remaining > 0) {
    lines.push(`…and ${remaining} more change${remaining === 1 ? "" : "s"}`);
  }
  return lines;
}
