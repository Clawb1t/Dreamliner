import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMemberContextSummary, memberContextLinkRow, type MemberContextData } from "./memberContext.js";

const base: MemberContextData = {
  userId: "123456789012345678",
  cases: [],
  openAppeal: null,
  passport: { state: "off" },
  previousTickets: [],
};

test("empty history reads as a clean slate", () => {
  const s = buildMemberContextSummary(base);
  assert.equal(s.activeCases, 0);
  assert.equal(s.totalCases, 0);
  assert.ok(s.lines.some((l) => l.includes("Cases: **none**")));
  assert.ok(s.lines.some((l) => l === "Open appeal: none"));
  assert.ok(s.lines.some((l) => l.includes("Passport: off")));
  assert.ok(s.lines.some((l) => l.includes("this is their first")));
});

test("overturned cases, notes and reversal types are not counted as infractions", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  const s = buildMemberContextSummary({
    ...base,
    cases: [
      { id: 5, type: "ban", active: true, overturned: true, createdAt: d },
      { id: 4, type: "unmute", active: false, overturned: false, createdAt: d },
      { id: 3, type: "mute", active: true, overturned: false, createdAt: d },
      { id: 2, type: "note", active: true, overturned: false, createdAt: d },
      { id: 1, type: "warn", active: false, overturned: false, createdAt: d },
    ],
  });
  assert.equal(s.activeCases, 1);
  assert.equal(s.totalCases, 2);
  assert.equal(s.overturnedCases, 1);
  assert.equal(s.notes, 1);
  assert.ok(s.lines.some((l) => l.includes("latest: mute #3")));
  assert.ok(s.lines.some((l) => l.startsWith("Overturned on appeal: **1**")));
});

test("open appeal, Passport and previous tickets", () => {
  const d = new Date("2026-02-01T00:00:00Z");
  const s = buildMemberContextSummary({
    ...base,
    openAppeal: { id: 9, status: "needs_info", caseId: 3 },
    passport: { state: "verified", verifiedAt: d },
    previousTickets: [
      { number: 12, status: "open", createdAt: d },
      { number: 7, status: "closed", createdAt: d },
    ],
    previousTicketsCapped: true,
  });
  assert.ok(s.lines.some((l) => l.includes("**#9**, waiting on more info (case #3)")));
  assert.ok(s.lines.some((l) => l.includes("Passport: **verified** <t:")));
  assert.ok(s.lines.some((l) => l.includes("Previous tickets: **2+** (1 still open)")));
});

test("summary copy has no em dashes", () => {
  const s = buildMemberContextSummary({ ...base, passport: { state: "pending" } });
  for (const line of s.lines) assert.ok(!line.includes("—"), line);
});

test("link row points at the identity card, cases and Member 360 hub", () => {
  const row = memberContextLinkRow("1537960888026402868", base.userId).toJSON();
  const urls = row.components.map((c) => ("url" in c ? c.url : ""));
  assert.equal(urls.length, 3);
  assert.ok(urls[0]!.endsWith(`/identity/1537960888026402868/${base.userId}`));
  assert.ok(urls[1]!.includes("section=cases") && urls[1]!.includes(`target=${base.userId}`));
  assert.ok(urls[2]!.includes(`section=member&user=${base.userId}`));
});
