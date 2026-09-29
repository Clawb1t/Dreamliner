import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageOn,
  daysUntilBirthday,
  formatBirthday,
  isCelebrationDue,
  isValidBirthday,
  localMoment,
  observedDate,
  ordinal,
  timeToMinutes,
} from "./dates.js";

test("validates real dates, and 29 February only with a leap birth year", () => {
  assert.ok(isValidBirthday(3, 14));
  assert.ok(isValidBirthday(2, 29));
  assert.ok(isValidBirthday(2, 29, 2000));
  assert.ok(!isValidBirthday(2, 29, 2001));
  assert.ok(!isValidBirthday(4, 31));
  assert.ok(!isValidBirthday(13, 1));
});

test("formats birthdays and ordinals", () => {
  assert.equal(formatBirthday({ month: 3, day: 14, year: 2000 }), "14 March");
  assert.equal(formatBirthday({ month: 3, day: 14, year: 2000 }, true), "14 March 2000");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), [
    "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st",
  ]);
});

test("works out ages only from a birth year", () => {
  assert.equal(ageOn({ month: 3, day: 14, year: 2000 }, 2026), 26);
  assert.equal(ageOn({ month: 3, day: 14, year: null }, 2026), null);
});

test("moves 29 February birthdays in other years", () => {
  const leapling = { month: 2, day: 29, year: null };
  assert.deepEqual(observedDate(leapling, 2028, "feb28"), { month: 2, day: 29 });
  assert.deepEqual(observedDate(leapling, 2027, "feb28"), { month: 2, day: 28 });
  assert.deepEqual(observedDate(leapling, 2027, "mar1"), { month: 3, day: 1 });
});

test("reads the local date in a timezone", () => {
  const at = new Date(Date.UTC(2026, 2, 13, 23, 30)); // 13 March 23:30 UTC
  assert.deepEqual(localMoment(at, "UTC"), { year: 2026, month: 3, day: 13, minutes: 23 * 60 + 30 });
  assert.equal(localMoment(at, "Asia/Tokyo").day, 14); // already 14 March in Tokyo
  assert.equal(localMoment(at, "GMT-5").day, 13);
});

test("a celebration is due on the day, from the celebration time", () => {
  const bday = { month: 3, day: 14, year: null };
  const nine = timeToMinutes("09:00");
  assert.ok(isCelebrationDue(bday, { year: 2026, month: 3, day: 14, minutes: 9 * 60 }, nine, "feb28"));
  assert.ok(!isCelebrationDue(bday, { year: 2026, month: 3, day: 14, minutes: 8 * 60 + 59 }, nine, "feb28"));
  assert.ok(!isCelebrationDue(bday, { year: 2026, month: 3, day: 15, minutes: 10 * 60 }, nine, "feb28"));
});

test("counts days until the next birthday", () => {
  const today = { year: 2026, month: 3, day: 10, minutes: 0 };
  assert.equal(daysUntilBirthday({ month: 3, day: 10, year: null }, today, "feb28"), 0);
  assert.equal(daysUntilBirthday({ month: 3, day: 14, year: null }, today, "feb28"), 4);
  assert.equal(daysUntilBirthday({ month: 3, day: 9, year: null }, today, "feb28"), 364);
});

test("finds the exact moment a birthday is next celebrated, in its timezone", async () => {
  const { nextCelebrationAt } = await import("./dates.js");
  const bday = { month: 3, day: 14, year: null };
  const now = new Date(Date.UTC(2026, 2, 10, 12, 0)); // 10 March 2026
  const nine = 9 * 60;
  assert.equal(nextCelebrationAt(bday, now, "UTC", nine, "feb28").toISOString(), "2026-03-14T09:00:00.000Z");
  // New York is on daylight time (UTC-4) by 14 March 2026.
  assert.equal(nextCelebrationAt(bday, now, "America/New_York", nine, "feb28").toISOString(), "2026-03-14T13:00:00.000Z");
  // Already past this year: next year's.
  const later = new Date(Date.UTC(2026, 5, 1));
  assert.equal(nextCelebrationAt(bday, later, "UTC", 0, "feb28").toISOString(), "2027-03-14T00:00:00.000Z");
});
