import { test } from "node:test";
import assert from "node:assert/strict";
import { zInviteTrackerConfig } from "../../../config/schemas/inviteTracker.js";
import { classifyJoin, classifyLeave, classifyVerified, pendingTimedOut, type JoinFacts } from "./classify.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const config = zInviteTrackerConfig.parse({});

function facts(extra: Partial<JoinFacts> = {}): JoinFacts {
  return {
    memberId: "member",
    inviterId: "inviter",
    isBot: false,
    accountCreatedAt: NOW - 100 * DAY,
    joinedAt: NOW,
    isRejoin: false,
    awaitingVerification: false,
    ...extra,
  };
}

test("an ordinary join is valid and counted", () => {
  assert.deepEqual(classifyJoin(facts(), config), { status: "valid", fakeReason: null, counted: true });
});

test("every fake reason", () => {
  assert.equal(classifyJoin(facts({ isBot: true }), config).fakeReason, "bot");
  assert.equal(classifyJoin(facts({ isBot: true }), { ...config, ignore_bots: false }).status, "valid");
  assert.equal(classifyJoin(facts({ inviterId: "member" }), config).fakeReason, "self");

  const blocked = zInviteTrackerConfig.parse({ blacklist: { user_ids: ["inviter"], role_ids: ["shady"] } });
  assert.equal(classifyJoin(facts(), blocked).fakeReason, "blacklist");
  assert.equal(classifyJoin(facts({ memberId: "inviter", inviterId: "x" }), blocked).fakeReason, "blacklist");
  assert.equal(classifyJoin(facts({ inviterId: "y", inviterRoleIds: ["shady"] }), blocked).fakeReason, "blacklist");

  assert.equal(classifyJoin(facts({ accountCreatedAt: NOW - 2 * DAY }), config).fakeReason, "account_age");
  const noAge = zInviteTrackerConfig.parse({ fake: { min_account_age_days: 0 } });
  assert.equal(classifyJoin(facts({ accountCreatedAt: NOW - 1000 }), noAge).status, "valid");

  assert.equal(classifyJoin(facts({ isRejoin: true }), config).fakeReason, "rejoin");
});

test("rejoin policies", () => {
  const count = zInviteTrackerConfig.parse({ fake: { rejoin_policy: "count" } });
  assert.deepEqual(classifyJoin(facts({ isRejoin: true }), count), { status: "valid", fakeReason: null, counted: true });
  const ignore = zInviteTrackerConfig.parse({ fake: { rejoin_policy: "ignore" } });
  assert.deepEqual(classifyJoin(facts({ isRejoin: true }), ignore), { status: "valid", fakeReason: null, counted: false });
});

test("pending → valid on verification, fake stays fake", () => {
  const pending = classifyJoin(facts({ awaitingVerification: true }), config);
  assert.equal(pending.status, "pending");
  assert.deepEqual(classifyVerified(pending), { status: "valid", fakeReason: null });
  assert.deepEqual(classifyVerified({ status: "fake", fakeReason: "self" }), { status: "fake", fakeReason: "self" });
  // A fake reason wins over waiting on Passport.
  assert.equal(classifyJoin(facts({ awaitingVerification: true, inviterId: "member" }), config).status, "fake");
});

test("pending → fake when they leave or time out unverified", () => {
  assert.deepEqual(classifyLeave({ status: "pending", fakeReason: null, joinedAt: NOW }, NOW + 1000, config), {
    status: "fake",
    fakeReason: "unverified",
  });
  assert.equal(pendingTimedOut(NOW, NOW + 71 * 3_600_000, config), false);
  assert.equal(pendingTimedOut(NOW, NOW + 72 * 3_600_000, config), true);
});

test("quick leaves count as left or fake", () => {
  const asLeft = zInviteTrackerConfig.parse({ fake: { quick_leave_minutes: 10 } });
  const asFake = zInviteTrackerConfig.parse({ fake: { quick_leave_minutes: 10, quick_leave_as: "fake" } });
  const valid = { status: "valid" as const, fakeReason: null, joinedAt: NOW };
  assert.deepEqual(classifyLeave(valid, NOW + 5 * 60_000, asLeft), { status: "valid", fakeReason: null });
  assert.deepEqual(classifyLeave(valid, NOW + 5 * 60_000, asFake), { status: "fake", fakeReason: "quick_leave" });
  assert.deepEqual(classifyLeave(valid, NOW + 11 * 60_000, asFake), { status: "valid", fakeReason: null });
});

test("config defaults round-trip", () => {
  const parsed = zInviteTrackerConfig.parse({});
  assert.deepEqual(zInviteTrackerConfig.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.equal(parsed.count_on, "join");
  assert.equal(parsed.fake.min_account_age_days, 7);
  assert.equal(parsed.join_message.message.content, "{user} joined, invited by **{inviter_name}** ({invites} invites)");
  assert.equal(parsed.can_view, true);
  assert.equal(parsed.can_manage, false);
});
