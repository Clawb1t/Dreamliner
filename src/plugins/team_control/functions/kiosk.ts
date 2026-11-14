/**
 * The web clock-in kiosk's pure rules: when it's available, which action a button press means,
 * and the time totals it shows. Free of Discord and the database so it can be tested; the bridge
 * (src/bridge/webTeamKiosk.ts) runs the actual shift changes through shifts.ts, the same
 * functions /team shift and the roster board use.
 */
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import type { QuotaKey, QuotaState, TeamMetrics } from "./quota.js";
import { shiftSecondsInRange, type ShiftTimes } from "./shiftMath.js";

const DAY_MS = 86_400_000;

export type KioskAvailability = "ok" | "plugin_off" | "kiosk_off" | "shifts_off";

/** Whether the kiosk can be used, and if not, the first reason why. */
export function kioskAvailability(pluginEnabled: boolean, config: Pick<TeamControlConfig, "kiosk" | "shifts">): KioskAvailability {
  if (!pluginEnabled) return "plugin_off";
  if (!config.kiosk.enabled) return "kiosk_off";
  if (!config.shifts.enabled) return "shifts_off";
  return "ok";
}

/** Breaks work from the kiosk only when both the shift settings and the kiosk allow them. */
export function kioskBreaksAllowed(config: Pick<TeamControlConfig, "kiosk" | "shifts">): boolean {
  return config.shifts.allow_breaks && config.kiosk.allow_breaks;
}

export const KIOSK_ACTIONS = ["clock_in", "break_start", "break_end", "clock_out"] as const;
export type KioskAction = (typeof KIOSK_ACTIONS)[number];

export function isKioskAction(value: unknown): value is KioskAction {
  return typeof value === "string" && (KIOSK_ACTIONS as readonly string[]).includes(value);
}

/** What a kiosk button press does to the shift functions, or why it can't. */
export type KioskPlan = { ok: true; run: "start" | "toggle_break" | "end" } | { ok: false; error: string; status: number };

/**
 * Turns a button press into a shift call. Buttons say what they mean ("start break", not
 * "toggle"), so a double tap or a page that's out of date can never flip a break back off or
 * clock someone in twice: the press is checked against the shift as it is right now.
 */
export function planKioskAction(
  action: KioskAction,
  shift: { breakStartedAt: Date | null } | null,
  options: { breaksAllowed: boolean },
): KioskPlan {
  switch (action) {
    case "clock_in":
      return shift ? { ok: false, status: 409, error: "You're already on shift." } : { ok: true, run: "start" };
    case "clock_out":
      return shift ? { ok: true, run: "end" } : { ok: false, status: 409, error: "You aren't on shift." };
    case "break_start":
      if (!options.breaksAllowed) return { ok: false, status: 403, error: "Breaks can't be taken from the kiosk on this server." };
      if (!shift) return { ok: false, status: 409, error: "Clock in before taking a break." };
      return shift.breakStartedAt ? { ok: false, status: 409, error: "You're already on break." } : { ok: true, run: "toggle_break" };
    case "break_end":
      // The kiosk's own break switch never blocks ending one (a break started on Discord can be
      // ended here); the shift settings' switch is still checked by toggleBreak, as on Discord.
      if (!shift) return { ok: false, status: 409, error: "You aren't on shift." };
      return shift.breakStartedAt ? { ok: true, run: "toggle_break" } : { ok: false, status: 409, error: "You aren't on break." };
  }
}

/**
 * The shift type to clock in with: the one picked (checked again by startShift), else the only
 * type the member's rank can use (like /team shift start), else none. A required pick with
 * types available and none chosen is refused.
 */
export function resolveKioskShiftType(
  picked: string | null,
  allowed: ReadonlyArray<{ id: string }>,
  requireType: boolean,
): { ok: true; typeId: string | null } | { ok: false; error: string } {
  if (picked) return { ok: true, typeId: picked };
  if (allowed.length === 1) return { ok: true, typeId: allowed[0]!.id };
  if (requireType && allowed.length > 0) return { ok: false, error: "Pick a shift type first." };
  return { ok: true, typeId: null };
}

/** The viewer's UTC offset in minutes as `Date#getTimezoneOffset` gives it (UTC minus local), clamped to real zones. */
export function parseTzOffset(raw: string | null | undefined): number {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n)) return 0;
  return Math.max(-840, Math.min(840, Math.trunc(n)));
}

/** [start, end) of the viewer's local day containing `now`, in UTC milliseconds. */
export function localDayRange(now: number, tzOffsetMinutes: number): { start: number; end: number } {
  const shift = tzOffsetMinutes * 60_000;
  const local = now - shift;
  const startLocal = Math.floor(local / DAY_MS) * DAY_MS;
  return { start: startLocal + shift, end: startLocal + shift + DAY_MS };
}

/** Seconds worked across shifts inside [from, to), breaks excluded (voided shifts should already be filtered out). */
export function secondsInRange(shifts: ShiftTimes[], from: number, to: number, now: number): number {
  let total = 0;
  for (const shift of shifts) total += shiftSecondsInRange(shift, from, to, now);
  return total;
}

export type KioskQuotaItem = { key: QuotaKey; actual: number; target: number; met: boolean };

/** One row per quota requirement, in the requirement's own unit (hours for time). */
export function kioskQuotaItems(quota: QuotaState, metrics: TeamMetrics): KioskQuotaItem[] {
  const actualFor = (key: QuotaKey): number => {
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
  };
  return (Object.entries(quota.required) as Array<[QuotaKey, number]>).map(([key, target]) => {
    const actual = Math.round(actualFor(key) * 100) / 100;
    return { key, actual, target, met: actual + 1e-9 >= target };
  });
}

/** Fills `{guild}` and `{user}` in the kiosk's headline and welcome text. */
export function renderKioskText(template: string, values: { guild: string; user?: string | null }): string {
  return template.replace(/\{(guild|server|user)\}/gi, (_m, key: string) => {
    const k = key.toLowerCase();
    if (k === "user") return values.user ?? "";
    return values.guild;
  });
}

/** `#rrggbb` for a stored colour int. */
export function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value))).toString(16).padStart(6, "0")}`;
}
