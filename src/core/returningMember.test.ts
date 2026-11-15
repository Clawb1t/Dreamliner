import { test } from "node:test";
import assert from "node:assert/strict";
import { wasMemberBefore } from "./returningMember.js";

const joinedAt = 1_700_000_000_000;
const none = { joinedAt, snapshotAt: null, firstTrackedJoinAt: null, messageCount: 0 };

test("brand new member is not returning", () => {
  assert.equal(wasMemberBefore(none), false);
});

test("Member Identity snapshot from before the join means returning", () => {
  assert.equal(wasMemberBefore({ ...none, snapshotAt: joinedAt - 60_000 }), true);
});

test("snapshot written after the join (role changes on join) doesn't count", () => {
  assert.equal(wasMemberBefore({ ...none, snapshotAt: joinedAt + 500 }), false);
  // Within the clock-skew window.
  assert.equal(wasMemberBefore({ ...none, snapshotAt: joinedAt - 1_000 }), false);
});

test("an earlier Invite Tracker join means returning", () => {
  assert.equal(wasMemberBefore({ ...none, firstTrackedJoinAt: joinedAt - 86_400_000 }), true);
  assert.equal(wasMemberBefore({ ...none, firstTrackedJoinAt: joinedAt }), false);
});

test("messages counted in this server mean returning", () => {
  assert.equal(wasMemberBefore({ ...none, messageCount: 3 }), true);
});
