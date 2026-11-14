/**
 * Tiny in-process counters read by the status monitor once a minute. Kept dependency-free so any
 * module (command dispatch, plugins) can bump them without import cycles.
 */
let commandsSinceSample = 0;

/** One command (slash, context menu or custom) ran. */
export function countCommand(): void {
  commandsSinceSample += 1;
}

/** Commands since the last call, then resets. */
export function takeCommandCount(): number {
  const n = commandsSinceSample;
  commandsSinceSample = 0;
  return n;
}
