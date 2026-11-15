import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDreamCommandUsage } from "./usage.js";
import { dateRange } from "../../stats/functions/daily.js";

const END = new Date("2026-11-15T12:00:00Z");
const dates = dateRange(30, END);

test("dateRange window ends today and is 30 days long", () => {
  assert.equal(dates.length, 30);
  assert.equal(dates.at(-1), "2026-11-15");
  assert.equal(dates[0], "2026-10-17");
});

test("per-command totals, 7 and 30 day windows, and last used date", () => {
  const summary = summarizeDreamCommandUsage(
    ["rules", "faq", "never"],
    [
      { commandName: "rules", uses: 50 },
      { commandName: "faq", uses: 3 },
      { commandName: "other", uses: 99 },
    ],
    [
      { commandName: "rules", statDate: "2026-11-15", uses: 4 },
      { commandName: "rules", statDate: "2026-11-09", uses: 2 }, // first day of the 7-day window
      { commandName: "rules", statDate: "2026-11-08", uses: 5 }, // just outside it
      { commandName: "rules", statDate: "2026-01-01", uses: 39 }, // outside 30 days
      { commandName: "faq", statDate: "2026-06-01", uses: 3 },
      { commandName: "other", statDate: "2026-11-15", uses: 7 }, // not one of ours
    ],
    dates,
  );

  assert.deepEqual(summary.byName.rules, { total: 50, last7d: 6, last30d: 11, lastUsedDate: "2026-11-15" });
  assert.deepEqual(summary.byName.faq, { total: 3, last7d: 0, last30d: 0, lastUsedDate: "2026-06-01" });
  assert.deepEqual(summary.byName.never, { total: 0, last7d: 0, last30d: 0, lastUsedDate: null });
  assert.equal(summary.total, 53);
  assert.equal(summary.last7d, 6);
  assert.equal(summary.last30d, 11);
  assert.equal(summary.daily.length, 30);
  assert.equal(summary.daily.at(-1)!.uses, 4);
  assert.equal(summary.daily.reduce((s, d) => s + d.uses, 0), 11);
});

test("no commands gives an empty, zero-filled summary", () => {
  const summary = summarizeDreamCommandUsage([], [], [], dates);
  assert.deepEqual(summary.byName, {});
  assert.equal(summary.total, 0);
  assert.equal(summary.daily.length, 30);
  assert.ok(summary.daily.every((d) => d.uses === 0));
});
