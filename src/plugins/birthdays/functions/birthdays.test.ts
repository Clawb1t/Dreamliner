import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-birthdays-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const { zBirthdaysConfig } = await import("../../../config/schemas/birthdays.js");
const { announcementButtons, birthdayTemplateVars, wishButtonLabel } = await import("./celebrate.js");
const store = await import("./store.js");
const { getDb } = await import("../../../db/client.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* leftover temp dir is harmless */
  }
});

const config = zBirthdaysConfig.parse({});

describe("birthday tokens", () => {
  it("fill in the age only with a birth year, and hide it when the server turns ages off", () => {
    const withYear = birthdayTemplateVars(config, { month: 3, day: 14, year: 2000 }, 2026, 2);
    assert.deepEqual(withYear, {
      age: "26",
      age_ordinal: "26th",
      birthday: "14 March",
      birthday_date: "14 March 2000",
      birthdays_today: "2",
    });
    assert.equal(birthdayTemplateVars(config, { month: 3, day: 14, year: null }, 2026, 1).age, "");
    const hidden = birthdayTemplateVars({ ...config, show_age: false }, { month: 3, day: 14, year: 2000 }, 2026, 1);
    assert.equal(hidden.age, "");
    assert.equal(hidden.birthday_date, "14 March");
  });
});

describe("announcement buttons", () => {
  it("put the wish button (with its tally) and link buttons in one row", () => {
    const announcement = zBirthdaysConfig.parse({
      announcement: {
        link_buttons: [
          { label: "Gift shop", url: "https://example.com" },
          { label: "Half typed", url: "" },
        ],
      },
    }).announcement;
    const rows = announcementButtons(announcement, 3).map((row) => row.toJSON());
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.components.length, 2, "the half-typed link is skipped");
    const [wish, link] = rows[0]!.components as Array<{ label?: string; url?: string; custom_id?: string }>;
    assert.equal(wish!.custom_id, "birthday:wish");
    assert.equal(wish!.label, "Wish happy birthday · 3");
    assert.equal(link!.url, "https://example.com");
  });

  it("hide the tally when asked, and leave no row when there are no buttons", () => {
    const quiet = zBirthdaysConfig.parse({ announcement: { wish_button: { show_count: false } } }).announcement;
    assert.equal(wishButtonLabel(quiet, 9), "Wish happy birthday");
    const none = zBirthdaysConfig.parse({ announcement: { wish_button: { enabled: false } } }).announcement;
    assert.equal(announcementButtons(none).length, 0);
  });
});

describe("store", () => {
  it("celebrates each birthday once a year per server", () => {
    const at = new Date();
    assert.ok(store.claimCelebration("g1", "u1", 2026, at));
    assert.ok(!store.claimCelebration("g1", "u1", 2026, at));
    assert.ok(store.claimCelebration("g2", "u1", 2026, at), "another server celebrates separately");
    assert.ok(store.claimCelebration("g1", "u1", 2027, at), "next year celebrates again");
    assert.ok(store.celebratedKeys("g1", ["u1"]).has("u1:2026"));
  });

  it("counts one wish per member", () => {
    assert.ok(store.addWish("m1", "a"));
    assert.ok(!store.addWish("m1", "a"));
    assert.ok(store.addWish("m1", "b"));
    assert.equal(store.countWishes("m1"), 2);
  });

  it("finds birthdays on the given dates and respects server opt-outs", () => {
    store.setBirthday("u-mar", { month: 3, day: 14, year: null }, "Europe/London");
    store.setBirthday("u-apr", { month: 4, day: 2, year: 1999 }, null);
    assert.deepEqual(
      store.birthdaysOnDates([{ month: 3, day: 14 }]).map((b) => b.userId),
      ["u-mar"],
    );
    store.setOptedOut("g1", "u-mar", true);
    assert.ok(store.isOptedOut("g1", "u-mar"));
    assert.ok(!store.isOptedOut("g2", "u-mar"));
    store.setOptedOut("g1", "u-mar", false);
    assert.ok(!store.isOptedOut("g1", "u-mar"));
  });
});
