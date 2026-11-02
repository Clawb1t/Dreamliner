/** Shift duration math, free of the database so it can be tested. */
export type ShiftTimes = {
  startedAt: Date;
  endedAt: Date | null;
  breakSeconds: number;
  breakStartedAt: Date | null;
};

/** Seconds of the break currently running (0 when not on break). */
export function runningBreakSeconds(shift: ShiftTimes, now = Date.now()): number {
  if (!shift.breakStartedAt) return 0;
  const end = shift.endedAt?.getTime() ?? now;
  return Math.max(0, Math.floor((end - shift.breakStartedAt.getTime()) / 1000));
}

/** Total break seconds, including a break that is still running. */
export function totalBreakSeconds(shift: ShiftTimes, now = Date.now()): number {
  return Math.max(0, shift.breakSeconds) + runningBreakSeconds(shift, now);
}

/** Seconds worked: start to end (or now), minus every break. */
export function shiftWorkedSeconds(shift: ShiftTimes, now = Date.now()): number {
  const end = shift.endedAt?.getTime() ?? now;
  const gross = Math.max(0, Math.floor((end - shift.startedAt.getTime()) / 1000));
  return Math.max(0, gross - totalBreakSeconds(shift, now));
}

/**
 * Seconds worked inside [from, to). Breaks aren't stored with their times, so a shift spanning
 * the boundary has its break time spread evenly across it.
 */
export function shiftSecondsInRange(shift: ShiftTimes, from: number, to: number, now = Date.now()): number {
  const start = shift.startedAt.getTime();
  const end = shift.endedAt?.getTime() ?? now;
  if (end <= start) return 0;
  const overlap = Math.max(0, Math.min(end, to) - Math.max(start, from));
  if (overlap === 0) return 0;
  const ratio = shiftWorkedSeconds(shift, now) / ((end - start) / 1000);
  return Math.floor((overlap / 1000) * ratio);
}

/** Ending a shift: closes any running break. Returns the stored break total. */
export function closeBreak(shift: ShiftTimes, at: number): number {
  if (!shift.breakStartedAt) return shift.breakSeconds;
  return shift.breakSeconds + Math.max(0, Math.floor((at - shift.breakStartedAt.getTime()) / 1000));
}

/** Whether a shift that ended this short is voided automatically. */
export function isTooShort(workedSeconds: number, minMinutes: number): boolean {
  return minMinutes > 0 && workedSeconds < minMinutes * 60;
}

/** Whether an active shift has run past `maxHours` (start to now, breaks included). */
export function isOverMax(shift: ShiftTimes, maxHours: number, now = Date.now()): boolean {
  return !shift.endedAt && now - shift.startedAt.getTime() >= maxHours * 3_600_000;
}
