import { test } from "node:test";
import assert from "node:assert/strict";
import { zTeamControlConfig } from "../../../config/schemas/teamControl.js";
import {
  colorIntToHex,
  isKioskAction,
  kioskAvailability,
  kioskBreaksAllowed,
  kioskQuotaItems,
  localDayRange,
  parseTzOffset,
  planKioskAction,
  renderKioskText,
  resolveKioskShiftType,
  secondsInRange,
} from "./kiosk.js";
import { EMPTY_METRICS } from "./quota.js";

const HOUR = 3_600_000;
const config = zTeamControlConfig.parse({});

test("kiosk config defaults are off and parse from an empty section", () => {
  assert.equal(config.kiosk.enabled, false);
  assert.equal(config.kiosk.layout, "split");
  assert.equal(config.kiosk.clock_format, "auto");
  assert.equal(config.kiosk.allow_breaks, true);
  assert.equal(config.kiosk.require_type, false);
  assert.equal(config.kiosk.confirm_clock_out, true);
  assert.equal(zTeamControlConfig.safeParse({ kiosk: { layout: "sideways" } }).success, false);
  assert.equal(zTeamControlConfig.safeParse({ kiosk: { clock_in_label: "" } }).success, false);
  assert.equal(zTeamControlConfig.safeParse({ kiosk: { accent_color: 0x1000000 } }).success, false);
});

test("kiosk availability checks the plugin, then the kiosk, then shifts", () => {
  const on = { ...config, kiosk: { ...config.kiosk, enabled: true } };
  assert.equal(kioskAvailability(false, on), "plugin_off");
  assert.equal(kioskAvailability(true, config), "kiosk_off");
  assert.equal(kioskAvailability(true, { ...on, shifts: { ...on.shifts, enabled: false } }), "shifts_off");
  assert.equal(kioskAvailability(true, on), "ok");
});

test("kiosk breaks need both the shift setting and the kiosk setting", () => {
  assert.equal(kioskBreaksAllowed(config), true);
  assert.equal(kioskBreaksAllowed({ ...config, kiosk: { ...config.kiosk, allow_breaks: false } }), false);
  assert.equal(kioskBreaksAllowed({ ...config, shifts: { ...config.shifts, allow_breaks: false } }), false);
});

test("kiosk actions are validated against the shift as it is now", () => {
  const breaks = { breaksAllowed: true };
  const onShift = { breakStartedAt: null };
  const onBreak = { breakStartedAt: new Date() };
  assert.deepEqual(planKioskAction("clock_in", null, breaks), { ok: true, run: "start" });
  assert.equal(planKioskAction("clock_in", onShift, breaks).ok, false);
  assert.deepEqual(planKioskAction("clock_out", onBreak, breaks), { ok: true, run: "end" });
  assert.equal(planKioskAction("clock_out", null, breaks).ok, false);
  assert.deepEqual(planKioskAction("break_start", onShift, breaks), { ok: true, run: "toggle_break" });
  // A double tap on "Start break" can't end the break it just started.
  assert.equal(planKioskAction("break_start", onBreak, breaks).ok, false);
  assert.equal(planKioskAction("break_start", null, breaks).ok, false);
  assert.deepEqual(planKioskAction("break_end", onBreak, breaks), { ok: true, run: "toggle_break" });
  assert.equal(planKioskAction("break_end", onShift, breaks).ok, false);
  const noBreaks = planKioskAction("break_start", onShift, { breaksAllowed: false });
  assert.equal(noBreaks.ok, false);
  assert.equal(!noBreaks.ok && noBreaks.status, 403);
  // Ending a break started elsewhere still works when the kiosk's own break switch is off.
  assert.equal(planKioskAction("break_end", onBreak, { breaksAllowed: false }).ok, true);
  assert.equal(isKioskAction("clock_in"), true);
  assert.equal(isKioskAction("toggle"), false);
  assert.equal(isKioskAction(42), false);
});

test("kiosk shift type: the pick, else the only allowed type, else required or none", () => {
  const two = [{ id: "mod" }, { id: "support" }];
  assert.deepEqual(resolveKioskShiftType("support", two, true), { ok: true, typeId: "support" });
  assert.deepEqual(resolveKioskShiftType(null, [{ id: "mod" }], true), { ok: true, typeId: "mod" });
  assert.deepEqual(resolveKioskShiftType(null, two, false), { ok: true, typeId: null });
  assert.equal(resolveKioskShiftType(null, two, true).ok, false);
  assert.deepEqual(resolveKioskShiftType(null, [], true), { ok: true, typeId: null });
});

test("kiosk days follow the viewer's time zone", () => {
  const now = Date.UTC(2026, 10, 14, 3, 30); // 03:30 UTC
  // UTC: the day started at midnight UTC.
  assert.deepEqual(localDayRange(now, 0), { start: Date.UTC(2026, 10, 14), end: Date.UTC(2026, 10, 15) });
  // New York (UTC-5, getTimezoneOffset 300): still the 13th there, 22:30.
  assert.deepEqual(localDayRange(now, 300), { start: Date.UTC(2026, 10, 13, 5), end: Date.UTC(2026, 10, 14, 5) });
  // Tokyo (UTC+9, offset -540): 12:30 on the 14th.
  assert.deepEqual(localDayRange(now, -540), { start: Date.UTC(2026, 10, 13, 15), end: Date.UTC(2026, 10, 14, 15) });
  assert.equal(parseTzOffset("300"), 300);
  assert.equal(parseTzOffset("-99999"), -840);
  assert.equal(parseTzOffset("abc"), 0);
  assert.equal(parseTzOffset(null), 0);
});

test("kiosk totals count breaks out and include a running shift", () => {
  const day = Date.UTC(2026, 10, 14);
  const now = day + 12 * HOUR;
  const shifts = [
    // 2h shift with 30m of breaks, all today.
    { startedAt: new Date(day + 8 * HOUR), endedAt: new Date(day + 10 * HOUR), breakSeconds: 1800, breakStartedAt: null },
    // Running shift that started an hour ago.
    { startedAt: new Date(now - HOUR), endedAt: null, breakSeconds: 0, breakStartedAt: null },
  ];
  assert.equal(secondsInRange(shifts, day, day + 24 * HOUR, now), 90 * 60 + 60 * 60);
  // A shift from yesterday 22:00 to 02:00 today counts only its two hours today.
  const overnight = [{ startedAt: new Date(day - 2 * HOUR), endedAt: new Date(day + 2 * HOUR), breakSeconds: 0, breakStartedAt: null }];
  assert.equal(secondsInRange(overnight, day, day + 24 * HOUR, now), 2 * 3600);
});

test("kiosk quota items carry each requirement in its own unit", () => {
  const items = kioskQuotaItems(
    { required: { shift_hours: 10, tickets: 5 }, met: false, excused: false, progress: 0.5 },
    { ...EMPTY_METRICS, shiftMinutes: 330, ticketsClosed: 5 },
  );
  assert.deepEqual(items, [
    { key: "shift_hours", actual: 5.5, target: 10, met: false },
    { key: "tickets", actual: 5, target: 5, met: true },
  ]);
  assert.deepEqual(kioskQuotaItems({ required: {}, met: true, excused: false, progress: 1 }, EMPTY_METRICS), []);
});

test("kiosk text fills guild and user placeholders", () => {
  assert.equal(renderKioskText("Clock in at {guild}, {user}!", { guild: "Skyline", user: "Ava" }), "Clock in at Skyline, Ava!");
  assert.equal(renderKioskText("{SERVER} staff", { guild: "Skyline" }), "Skyline staff");
  assert.equal(renderKioskText("Hi {user}", { guild: "Skyline", user: "{user}" }), "Hi {user}");
  assert.equal(colorIntToHex(0x5662f5), "#5662f5");
  assert.equal(colorIntToHex(0), "#000000");
});
