import { test } from "node:test";
import assert from "node:assert/strict";
import { zTeamControlConfig, type TeamRank } from "../../../config/schemas/teamControl.js";
import { checkAuthority, rankIndexForRoles, resolveRankMove } from "./authority.js";
import { extendLeave, isExcusedFromPeriod, validateLeaveRequest } from "./leaveRules.js";
import { daysIn, overlapFraction, periodLabel, periodRange, toTeamPeriod, weekStartOf } from "./periods.js";
import { computePoints, EMPTY_METRICS, evaluateQuota, summarizeQuotas } from "./quota.js";
import { closeBreak, isOverMax, isTooShort, shiftSecondsInRange, shiftWorkedSeconds } from "./shiftMath.js";
import { countActiveStrikes, crossedThreshold, strikeExpiry } from "./strikes.js";

const DAY = 86_400_000;
const config = zTeamControlConfig.parse({});
const rank = (id: string, role: string | null, quota: Partial<TeamRank["quota"]> = {}): TeamRank => ({
  id,
  name: id.toUpperCase(),
  role_id: role,
  quota: { shift_hours: 0, mod_actions: 0, tickets: 0, messages: 0, voice_hours: 0, ...quota },
  points_quota: 0,
});
const ranks = [rank("trial", "1"), rank("mod", "2"), rank("senior", "3"), rank("admin", "4")];

// ── Periods ──

test("weekly periods start on Monday or Sunday at 00:00 UTC", () => {
  const wed = Date.UTC(2026, 10, 4, 15, 30); // Wednesday 4 Nov 2026
  assert.equal(new Date(weekStartOf(wed, "monday")).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(new Date(weekStartOf(wed, "sunday")).toISOString(), "2026-11-01T00:00:00.000Z");
  const sunday = Date.UTC(2026, 10, 8, 23);
  assert.equal(new Date(weekStartOf(sunday, "monday")).toISOString(), "2026-11-02T00:00:00.000Z");
  const range = periodRange("weekly", "monday", "previous", wed);
  assert.equal(range.start.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(periodLabel(periodRange("weekly", "monday", "current", wed)), "Week of Nov 2");
});

test("monthly periods cross year boundaries", () => {
  const jan = Date.UTC(2027, 0, 15);
  const prev = periodRange("monthly", "monday", "previous", jan);
  assert.equal(prev.start.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(prev.end.toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(periodLabel(prev), "December 2026");
  assert.equal(toTeamPeriod(prev).end, "2026-12-31T23:59:59.999Z");
});

test("biweekly periods are 14 days, aligned and consecutive", () => {
  const now = Date.UTC(2026, 10, 4);
  const cur = periodRange("biweekly", "monday", "current", now);
  const prev = periodRange("biweekly", "monday", "previous", now);
  assert.equal(cur.end.getTime() - cur.start.getTime(), 14 * DAY);
  assert.equal(prev.end.getTime(), cur.start.getTime());
  assert.equal(cur.start.getUTCDay(), 1);
  assert.ok(cur.start.getTime() <= now && now < cur.end.getTime());
  // Every moment inside the same fortnight lands in the same period.
  assert.equal(periodRange("biweekly", "monday", "current", cur.end.getTime() - 1).start.getTime(), cur.start.getTime());
});

test("overlap and day helpers", () => {
  assert.equal(overlapFraction(0, 5, 0, 10), 0.5);
  assert.equal(overlapFraction(20, 30, 0, 10), 0);
  assert.deepEqual(daysIn(Date.UTC(2026, 0, 30, 12), Date.UTC(2026, 1, 2)), ["2026-01-30", "2026-01-31", "2026-02-01"]);
});

// ── Quotas ──

test("per-metric quota needs every non-zero target", () => {
  const quota = rank("x", null, { shift_hours: 2, mod_actions: 5 }).quota;
  const opts = { pointsMode: false, pointsQuota: 0, excused: false, countsMessages: true };
  const missing = evaluateQuota(quota, { ...EMPTY_METRICS, shiftMinutes: 180, modActions: 2 }, opts);
  assert.equal(missing.met, false);
  assert.deepEqual(missing.required, { shift_hours: 2, mod_actions: 5 });
  assert.equal(missing.progress, 0.7);
  assert.equal(evaluateQuota(quota, { ...EMPTY_METRICS, shiftMinutes: 120, modActions: 5 }, opts).met, true);
  assert.deepEqual(evaluateQuota(rank("x", null).quota, EMPTY_METRICS, opts), { required: {}, met: true, excused: false, progress: 1 });
});

test("messages targets are skipped without staff channels; excused is reported", () => {
  const quota = rank("x", null, { messages: 50 }).quota;
  const state = evaluateQuota(quota, EMPTY_METRICS, { pointsMode: false, pointsQuota: 0, excused: true, countsMessages: false });
  assert.equal(state.met, true);
  assert.equal(state.excused, true);
  const missed = evaluateQuota(quota, EMPTY_METRICS, { pointsMode: false, pointsQuota: 0, excused: false, countsMessages: true });
  assert.equal(missed.met, false);
  assert.deepEqual(summarizeQuotas([state, missed, { ...missed, met: true }]), { met: 1, missed: 1, excused: 1 });
});

test("points mode weighs every metric", () => {
  const weights = config.activity.weights;
  const metrics = { ...EMPTY_METRICS, shiftMinutes: 90, modActions: 3, ticketsClosed: 2, staffMessages: 15, voiceMinutes: 60 };
  // 1.5h*10 + 3*2 + 2*3 + 15*0.1 + 1h*2 = 30.5
  assert.equal(computePoints(metrics, weights), 30.5);
  const opts = { pointsMode: true, pointsQuota: 30, excused: false, countsMessages: true };
  const state = evaluateQuota(rank("x", null, { shift_hours: 100 }).quota, { ...metrics, points: 30.5 }, opts);
  assert.deepEqual(state.required, { points: 30 });
  assert.equal(state.met, true);
  assert.equal(evaluateQuota(null, { ...metrics, points: 10 }, opts).met, false);
});

test("leave covering half a period excuses the member", () => {
  const from = 0;
  const to = 7 * DAY;
  const leave = (start: number, end: number, status = "approved", endedAt: number | null = null) => ({
    status,
    startsAt: new Date(start),
    endsAt: new Date(end),
    endedAt: endedAt === null ? null : new Date(endedAt),
  });
  assert.equal(isExcusedFromPeriod([leave(0, 3.5 * DAY)], from, to), true);
  assert.equal(isExcusedFromPeriod([leave(0, 3 * DAY)], from, to), false);
  assert.equal(isExcusedFromPeriod([leave(0, 2 * DAY), leave(4 * DAY, 6 * DAY)], from, to), true);
  assert.equal(isExcusedFromPeriod([leave(0, 2 * DAY), leave(1 * DAY, 3 * DAY)], from, to), false);
  assert.equal(isExcusedFromPeriod([leave(0, 7 * DAY, "denied")], from, to), false);
  assert.equal(isExcusedFromPeriod([leave(0, 7 * DAY, "ended", 1 * DAY)], from, to), false);
});

// ── Authority ──

test("rank comes from the highest rank role held", () => {
  assert.equal(rankIndexForRoles(ranks, ["2", "1", "99"]), 1);
  assert.equal(rankIndexForRoles(ranks, ["99"]), -1);
});

test("actors act only below their rank and promote only below themselves", () => {
  const senior = { bypass: false, rankIndex: 2, userId: "a" };
  assert.equal(checkAuthority(senior, "b", 1, "warning", ranks).ok, true);
  assert.equal(checkAuthority(senior, "b", 2, "warning", ranks).ok, false);
  assert.equal(checkAuthority(senior, "b", 0, "promotion", ranks, 1).ok, true);
  assert.equal(checkAuthority(senior, "b", 1, "promotion", ranks, 2).ok, false);
  assert.equal(checkAuthority(senior, "a", 0, "warning", ranks).ok, false);
  assert.equal(checkAuthority({ bypass: false, rankIndex: -1, userId: "a" }, "b", 0, "warning", ranks).ok, false);
  assert.equal(checkAuthority({ bypass: true, rankIndex: -1, userId: "a" }, "b", 3, "promotion", ranks, 3).ok, true);
});

test("rank moves default to one step and validate targets", () => {
  assert.deepEqual(resolveRankMove(ranks, "promotion", 0), { ok: true, toIndex: 1 });
  assert.deepEqual(resolveRankMove(ranks, "promotion", -1), { ok: true, toIndex: 0 });
  assert.equal(resolveRankMove(ranks, "promotion", 3).ok, false);
  assert.deepEqual(resolveRankMove(ranks, "demotion", 2), { ok: true, toIndex: 1 });
  assert.equal(resolveRankMove(ranks, "demotion", 0).ok, false);
  assert.equal(resolveRankMove(ranks, "promotion", 2, "mod").ok, false);
  assert.deepEqual(resolveRankMove(ranks, "promotion", 0, "senior"), { ok: true, toIndex: 2 });
  assert.equal(resolveRankMove([rank("a", "1"), rank("b", null)], "promotion", 0).ok, false);
  assert.equal(resolveRankMove(ranks, "demotion", 1, "nope").ok, false);
});

// ── Strikes ──

test("active strikes skip voided and expired ones", () => {
  const now = 1_000_000;
  const rows = [
    { type: "strike", voidedAt: null, expiresAt: null },
    { type: "strike", voidedAt: new Date(1), expiresAt: null },
    { type: "strike", voidedAt: null, expiresAt: new Date(now - 1) },
    { type: "strike", voidedAt: null, expiresAt: new Date(now + 1) },
    { type: "warning", voidedAt: null, expiresAt: null },
  ];
  assert.equal(countActiveStrikes(rows, now), 2);
  assert.equal(strikeExpiry(0), null);
  assert.equal(strikeExpiry(10, 0)!.getTime(), 10 * DAY);
});

test("thresholds fire once, when crossed, preferring the highest and most severe", () => {
  const thresholds = [
    { strikes: 3, action: "notify" as const, suspend_days: 7 },
    { strikes: 3, action: "suspend" as const, suspend_days: 7 },
    { strikes: 5, action: "terminate" as const, suspend_days: 7 },
  ];
  assert.equal(crossedThreshold(thresholds, 1, 2), null);
  assert.equal(crossedThreshold(thresholds, 2, 3)!.action, "suspend");
  assert.equal(crossedThreshold(thresholds, 3, 4), null);
  assert.equal(crossedThreshold(thresholds, 4, 5)!.action, "terminate");
  assert.equal(crossedThreshold(thresholds, 2, 6)!.strikes, 5);
});

// ── Shifts ──

test("worked time excludes stored and running breaks", () => {
  const start = new Date(0);
  const shift = { startedAt: start, endedAt: new Date(3_600_000), breakSeconds: 600, breakStartedAt: null };
  assert.equal(shiftWorkedSeconds(shift), 3000);
  const running = { startedAt: start, endedAt: null, breakSeconds: 0, breakStartedAt: new Date(1_800_000) };
  assert.equal(shiftWorkedSeconds(running, 3_600_000), 1800);
  assert.equal(closeBreak(running, 2_400_000), 600);
  assert.equal(closeBreak(shift, 9_999_999), 600);
});

test("shift time in a range spreads breaks evenly", () => {
  const shift = { startedAt: new Date(0), endedAt: new Date(4 * 3_600_000), breakSeconds: 3600, breakStartedAt: null };
  // Half the shift is in the range, so half of the 3 worked hours.
  assert.equal(shiftSecondsInRange(shift, 2 * 3_600_000, 10 * 3_600_000), 5400);
  assert.equal(shiftSecondsInRange(shift, 5 * 3_600_000, 6 * 3_600_000), 0);
});

test("short shifts are voided and long ones end", () => {
  assert.equal(isTooShort(240, 5), true);
  assert.equal(isTooShort(300, 5), false);
  assert.equal(isTooShort(10, 0), false);
  const shift = { startedAt: new Date(0), endedAt: null, breakSeconds: 0, breakStartedAt: null };
  assert.equal(isOverMax(shift, 12, 12 * 3_600_000), true);
  assert.equal(isOverMax(shift, 12, 11 * 3_600_000), false);
});

// ── Leave ──

test("leave requests follow the server's rules", () => {
  const rules = { ...config.leave, min_days: 2, max_days: 14, cooldown_days: 7, require_reason: true };
  const free = { hasOpen: false, lastDecidedAt: null };
  const now = 1_000 * DAY;
  assert.equal(validateLeaveRequest({ days: 1, startsInDays: 0, reason: "x" }, rules, free, now).ok, false);
  assert.equal(validateLeaveRequest({ days: 15, startsInDays: 0, reason: "x" }, rules, free, now).ok, false);
  assert.equal(validateLeaveRequest({ days: 3, startsInDays: 0, reason: "  " }, rules, free, now).ok, false);
  assert.equal(validateLeaveRequest({ days: 3, startsInDays: 0, reason: "x" }, rules, { hasOpen: true, lastDecidedAt: null }, now).ok, false);
  assert.equal(validateLeaveRequest({ days: 3, startsInDays: 0, reason: "x" }, rules, { hasOpen: false, lastDecidedAt: new Date(now - 2 * DAY) }, now).ok, false);
  const ok = validateLeaveRequest({ days: 3, startsInDays: 2, reason: "Holiday" }, rules, { hasOpen: false, lastDecidedAt: new Date(now - 8 * DAY) }, now);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.startsAt.getTime(), now + 2 * DAY);
    assert.equal(ok.endsAt.getTime(), now + 5 * DAY);
  }
  assert.equal(validateLeaveRequest({ days: 3, startsInDays: 0, reason: "" }, { ...rules, require_reason: false }, free, now).ok, true);
});

test("extending leave respects the maximum", () => {
  const leave = { startsAt: new Date(0), endsAt: new Date(10 * DAY) };
  assert.deepEqual(extendLeave(leave, 4, 14), { ok: true, endsAt: new Date(14 * DAY) });
  assert.equal(extendLeave(leave, 5, 14).ok, false);
  assert.equal(extendLeave(leave, 0, 14).ok, false);
});

test("config defaults parse and match the contract", () => {
  assert.deepEqual(config.ranks, []);
  assert.equal(config.shifts.min_minutes, 5);
  assert.equal(config.roster.title, "Team roster");
  assert.deepEqual(config.actions.strike_thresholds, [{ strikes: 3, action: "notify", suspend_days: 7 }]);
  assert.deepEqual(config.activity.weights, { shift_hour: 10, mod_action: 2, ticket: 3, message: 0.1, voice_hour: 2 });
  assert.equal(config.can_view_team, true);
  assert.equal(config.can_manage, false);
  assert.ok(zTeamControlConfig.safeParse({ ranks: [{ id: "rank_ab12cd", name: "x".repeat(32), role_id: null }] }).success);
  assert.ok(!zTeamControlConfig.safeParse({ ranks: [{ id: "Bad Id", name: "x" }] }).success);
});
