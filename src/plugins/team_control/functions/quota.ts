import type { TeamQuota, TeamWeights } from "../../../config/schemas/teamControl.js";

export type TeamMetrics = {
  shiftMinutes: number;
  modActions: number;
  ticketsClosed: number;
  staffMessages: number;
  voiceMinutes: number;
  /** Weighted points, only in points mode. */
  points: number | null;
};

export type QuotaKey = "shift_hours" | "mod_actions" | "tickets" | "messages" | "voice_hours" | "points";

export type QuotaState = {
  required: Partial<Record<QuotaKey, number>>;
  met: boolean;
  excused: boolean;
  /** 0-1 across every requirement. */
  progress: number;
};

export const EMPTY_METRICS: TeamMetrics = { shiftMinutes: 0, modActions: 0, ticketsClosed: 0, staffMessages: 0, voiceMinutes: 0, points: null };

/** Weighted points for one member's metrics, to one decimal place. */
export function computePoints(metrics: Omit<TeamMetrics, "points">, weights: TeamWeights): number {
  const raw =
    (metrics.shiftMinutes / 60) * weights.shift_hour +
    metrics.modActions * weights.mod_action +
    metrics.ticketsClosed * weights.ticket +
    metrics.staffMessages * weights.message +
    (metrics.voiceMinutes / 60) * weights.voice_hour;
  return Math.round(raw * 10) / 10;
}

/** The value a metric's requirement is compared with, in the requirement's own unit. */
function actualFor(key: QuotaKey, metrics: TeamMetrics): number {
  switch (key) {
    case "shift_hours":
      return metrics.shiftMinutes / 60;
    case "mod_actions":
      return metrics.modActions;
    case "tickets":
      return metrics.ticketsClosed;
    case "messages":
      return metrics.staffMessages;
    case "voice_hours":
      return metrics.voiceMinutes / 60;
    case "points":
      return metrics.points ?? 0;
  }
}

export type QuotaOptions = {
  pointsMode: boolean;
  pointsQuota: number;
  excused: boolean;
  /** False when no staff channels are set up: a messages target can't be measured, so it's skipped. */
  countsMessages: boolean;
};

/**
 * Whether a member met their rank's quota. Per-metric mode needs every non-zero target met; points
 * mode needs the weighted total to reach `pointsQuota`. With nothing required the quota is met.
 * Excused members (on leave for at least half the period) keep their real numbers but are
 * reported as excused rather than missed.
 */
export function evaluateQuota(quota: TeamQuota | null, metrics: TeamMetrics, options: QuotaOptions): QuotaState {
  const required: Partial<Record<QuotaKey, number>> = {};
  if (options.pointsMode) {
    if (options.pointsQuota > 0) required.points = options.pointsQuota;
  } else if (quota) {
    if (quota.shift_hours > 0) required.shift_hours = quota.shift_hours;
    if (quota.mod_actions > 0) required.mod_actions = quota.mod_actions;
    if (quota.tickets > 0) required.tickets = quota.tickets;
    if (quota.messages > 0 && options.countsMessages) required.messages = quota.messages;
    if (quota.voice_hours > 0) required.voice_hours = quota.voice_hours;
  }
  const keys = Object.keys(required) as QuotaKey[];
  if (keys.length === 0) return { required, met: true, excused: options.excused, progress: 1 };
  let met = true;
  let progressSum = 0;
  for (const key of keys) {
    const target = required[key]!;
    const actual = actualFor(key, metrics);
    if (actual + 1e-9 < target) met = false;
    progressSum += Math.min(1, actual / target);
  }
  return { required, met, excused: options.excused, progress: Math.round((progressSum / keys.length) * 1000) / 1000 };
}

/** Met / missed / excused totals for a list of quota states (excused wins over met and missed). */
export function summarizeQuotas(states: QuotaState[]): { met: number; missed: number; excused: number } {
  const out = { met: 0, missed: 0, excused: 0 };
  for (const state of states) {
    if (state.excused) out.excused += 1;
    else if (state.met) out.met += 1;
    else out.missed += 1;
  }
  return out;
}
