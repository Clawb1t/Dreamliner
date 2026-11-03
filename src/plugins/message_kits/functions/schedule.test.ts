import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScheduleRule, daysInMonth, isValidTimezone, nextRunAt, zonedTimeToUtc, type ScheduleRule } from "./schedule.js";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const at = (value: string) => Date.parse(value);
const rule = (r: Partial<ScheduleRule>): ScheduleRule => ({ repeat: "daily", timeOfDay: "09:00", timezone: "UTC", ...r });

test("time zones and wall clock conversion", () => {
  assert.ok(isValidTimezone("Europe/London"));
  assert.ok(!isValidTimezone("Mars/Olympus"));
  assert.equal(iso(zonedTimeToUtc(2026, 7, 1, 9, 0, "Europe/London")), "2026-07-01T08:00:00.000Z");
  assert.equal(iso(zonedTimeToUtc(2026, 1, 15, 9, 0, "Europe/London")), "2026-01-15T09:00:00.000Z");
  assert.equal(iso(zonedTimeToUtc(2026, 1, 15, 9, 0, "Asia/Kolkata")), "2026-01-15T03:30:00.000Z");
});

test("DST gaps run just after the gap, repeated hours run the first time", () => {
  // 8 March 2026: New York skips 02:00-03:00.
  assert.equal(iso(zonedTimeToUtc(2026, 3, 8, 2, 30, "America/New_York")), "2026-03-08T07:30:00.000Z"); // 03:30 EDT
  // 1 November 2026: 01:30 happens twice; the first is EDT (UTC-4).
  assert.equal(iso(zonedTimeToUtc(2026, 11, 1, 1, 30, "America/New_York")), "2026-11-01T05:30:00.000Z");
});

test("daily schedules keep their local time across DST", () => {
  const r = rule({ timezone: "Europe/London", timeOfDay: "09:00" });
  assert.equal(iso(nextRunAt(r, at("2026-03-28T10:00:00Z"))), "2026-03-29T08:00:00.000Z"); // clocks went forward that night
  assert.equal(iso(nextRunAt(r, at("2026-03-29T07:59:00Z"))), "2026-03-29T08:00:00.000Z");
  assert.equal(iso(nextRunAt(r, at("2026-03-29T08:00:00Z"))), "2026-03-30T08:00:00.000Z", "strictly after");
});

test("daily schedules in zones ahead of UTC don't skip a day", () => {
  const r = rule({ timezone: "Pacific/Auckland", timeOfDay: "08:00" });
  // 2026-11-03T18:00Z is 4 Nov 07:00 in Auckland (NZDT, UTC+13).
  assert.equal(iso(nextRunAt(r, at("2026-11-03T18:00:00Z"))), "2026-11-03T19:00:00.000Z");
});

test("weekly schedules pick the right weekday in the zone", () => {
  const r = rule({ repeat: "weekly", weekday: 1, timeOfDay: "18:30", timezone: "America/Los_Angeles" });
  // Tue 3 Nov 2026 → next Monday 9 Nov 18:30 PST = 10 Nov 02:30Z.
  assert.equal(iso(nextRunAt(r, at("2026-11-03T12:00:00Z"))), "2026-11-10T02:30:00.000Z");
  // Monday 2 Nov 18:00 PST (03 Nov 02:00Z) → same day 18:30.
  assert.equal(iso(nextRunAt(r, at("2026-11-03T02:00:00Z"))), "2026-11-03T02:30:00.000Z");
});

test("monthly schedules clamp to the last day of short months", () => {
  const r = rule({ repeat: "monthly", monthDay: 31, timeOfDay: "12:00" });
  assert.equal(iso(nextRunAt(r, at("2026-04-01T00:00:00Z"))), "2026-04-30T12:00:00.000Z");
  assert.equal(iso(nextRunAt(r, at("2027-02-01T00:00:00Z"))), "2027-02-28T12:00:00.000Z");
  assert.equal(iso(nextRunAt(r, at("2028-02-01T00:00:00Z"))), "2028-02-29T12:00:00.000Z");
  assert.equal(iso(nextRunAt(r, at("2026-12-31T12:00:00Z"))), "2027-01-31T12:00:00.000Z");
  assert.equal(daysInMonth(2026, 2), 28);
});

test("one-off schedules and rule checks", () => {
  const r = rule({ repeat: "none", date: "2026-12-25", timeOfDay: "08:00", timezone: "Europe/Paris" });
  assert.equal(iso(nextRunAt(r, at("2026-11-03T00:00:00Z"))), "2026-12-25T07:00:00.000Z");
  assert.deepEqual(checkScheduleRule({ ...r, date: "2026-02-30" }), { ok: false, field: "date", error: "Pick a date." });
  assert.equal(checkScheduleRule({ ...r, timeOfDay: "25:00" }).ok, false);
  assert.equal(checkScheduleRule(rule({ repeat: "weekly", weekday: 7 })).ok, false);
  assert.equal(checkScheduleRule(rule({ repeat: "monthly", monthDay: 0 })).ok, false);
  assert.equal(checkScheduleRule(rule({ timezone: "nope" })).ok, false);
  assert.equal(nextRunAt(rule({ timezone: "nope" }), Date.now()), null);
});
