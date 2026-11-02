import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeJoin, type CachedInvite, type InviteSnapshot } from "./attribution.js";

const NOW = 1_800_000_000_000;

function invite(uses: number, extra: Partial<CachedInvite> = {}): CachedInvite {
  return { uses, maxUses: 0, inviterId: "inviter-a", expiresAt: null, channelId: "chan", ...extra };
}

function snap(invites: Record<string, CachedInvite>, vanityUses: number | null = null, permOk = true): InviteSnapshot {
  return { invites: new Map(Object.entries(invites)), vanityUses, permOk };
}

test("a single increment is the invite used", () => {
  const result = attributeJoin({
    before: snap({ abc: invite(3), def: invite(1, { inviterId: "inviter-b" }) }),
    after: snap({ abc: invite(3), def: invite(2, { inviterId: "inviter-b" }) }),
    isBot: false,
    now: NOW,
  });
  assert.deepEqual(result, { source: "invite", code: "def", inviterId: "inviter-b", channelId: "chan" });
});

test("a new code with uses (its create event was missed) still counts", () => {
  const result = attributeJoin({ before: snap({}), after: snap({ new1: invite(1) }), isBot: false, now: NOW });
  assert.equal(result.code, "new1");
});

test("a single-use invite that vanished is the one used", () => {
  const result = attributeJoin({
    before: snap({ once: invite(0, { maxUses: 1 }), other: invite(5) }),
    after: snap({ other: invite(5) }),
    isBot: false,
    now: NOW,
  });
  assert.equal(result.source, "invite");
  assert.equal(result.code, "once");
});

test("an expired invite that vanished is not counted", () => {
  const result = attributeJoin({
    before: snap({ old: invite(2, { expiresAt: NOW - 1000 }) }),
    after: snap({}),
    isBot: false,
    now: NOW,
  });
  assert.equal(result.source, "unknown");
  assert.equal(result.code, null);
});

test("the vanity URL going up is a vanity join", () => {
  const result = attributeJoin({ before: snap({ abc: invite(3) }, 10), after: snap({ abc: invite(3) }, 11), isBot: false, now: NOW });
  assert.deepEqual(result, { source: "vanity", code: null, inviterId: null, channelId: null });
});

test("a bot joining is oauth, even with no snapshots", () => {
  assert.equal(attributeJoin({ before: null, after: null, isBot: true }).source, "oauth");
});

test("several increments at once are unknown", () => {
  const result = attributeJoin({
    before: snap({ a: invite(1), b: invite(1) }),
    after: snap({ a: invite(2), b: invite(2) }),
    isBot: false,
    now: NOW,
  });
  assert.equal(result.source, "unknown");
});

test("a cold cache or missing Manage Server is unknown", () => {
  assert.equal(attributeJoin({ before: null, after: snap({ a: invite(1) }), isBot: false }).source, "unknown");
  assert.equal(
    attributeJoin({ before: snap({ a: invite(0) }, null, false), after: snap({ a: invite(1) }), isBot: false }).source,
    "unknown",
  );
});

test("a tracked link's code is tracked and credits nobody", () => {
  const result = attributeJoin({
    before: snap({ link: invite(0, { inviterId: "bot" }) }),
    after: snap({ link: invite(1, { inviterId: "bot" }) }),
    isBot: false,
    trackedCodes: new Set(["link"]),
    now: NOW,
  });
  assert.deepEqual(result, { source: "tracked", code: "link", inviterId: null, channelId: "chan" });
});
