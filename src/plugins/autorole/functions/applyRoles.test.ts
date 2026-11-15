import { test } from "node:test";
import assert from "node:assert/strict";
import { zAutoroleConfig } from "../../../config/schemas/autorole.js";
import { planAutoroleJoin, shouldScheduleAfterPassport, shouldSkipForRestore } from "./applyRoles.js";

test("new flags default off", () => {
  const config = zAutoroleConfig.parse({});
  assert.equal(config.wait_for_passport, false);
  assert.equal(config.skip_if_restored, false);
});

test("wait_for_passport holds humans who still need to verify", () => {
  const wait = { wait_for_passport: true };
  assert.equal(planAutoroleJoin(wait, "humans", false), "wait_for_passport");
  assert.equal(planAutoroleJoin(wait, "humans", true), "now");
  // Bots never verify, so the bots list is never held.
  assert.equal(planAutoroleJoin(wait, "bots", false), "now");
  assert.equal(planAutoroleJoin({ wait_for_passport: false }, "humans", false), "now");
});

test("skip_if_restored only skips when roles were actually restored", () => {
  assert.equal(shouldSkipForRestore({ skip_if_restored: true }, true), true);
  assert.equal(shouldSkipForRestore({ skip_if_restored: true }, false), false);
  assert.equal(shouldSkipForRestore({ skip_if_restored: false }, true), false);
});

test("after Passport: schedules held members, and joins from before a restart", () => {
  const base = { config: { wait_for_passport: true }, audience: "humans" as const, processStartedAt: 1_000 };
  assert.equal(shouldScheduleAfterPassport({ ...base, heldAtJoin: true, joinedAt: 2_000 }), true);
  // Joined while this process was running but wasn't held: already got roles at join.
  assert.equal(shouldScheduleAfterPassport({ ...base, heldAtJoin: false, joinedAt: 2_000 }), false);
  // Joined before a restart: the held set was lost, so give the roles.
  assert.equal(shouldScheduleAfterPassport({ ...base, heldAtJoin: false, joinedAt: 500 }), true);
  assert.equal(shouldScheduleAfterPassport({ ...base, config: { wait_for_passport: false }, heldAtJoin: true, joinedAt: 2_000 }), false);
  assert.equal(shouldScheduleAfterPassport({ ...base, audience: "bots", heldAtJoin: true, joinedAt: 2_000 }), false);
});
