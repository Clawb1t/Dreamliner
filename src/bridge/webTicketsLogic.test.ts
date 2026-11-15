import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseTicketBulkBody,
  parseTicketSort,
  parseTicketView,
  sortTickets,
  summarizeTickets,
  ticketMatchesView,
  ticketWaitInfo,
} from "./webTicketsLogic.js";
import { formatWebReply } from "../plugins/tickets/functions/actions.js";

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

type T = Parameters<typeof summarizeTickets>[0][number] & { id: number };

function ticket(id: number, patch: Partial<T> = {}): T {
  const createdAt = new Date(NOW - id * MIN);
  return {
    id,
    status: "open",
    subStatus: null,
    claimedBy: null,
    createdAt,
    lastActivityAt: createdAt,
    lastStaffReplyAt: null,
    escalationStep: -1,
    closedAt: null,
    ratingScore: null,
    ...patch,
  };
}

describe("web tickets logic", () => {
  it("parses views and sorts, falling back safely", () => {
    assert.equal(parseTicketView("unclaimed"), "unclaimed");
    assert.equal(parseTicketView("nope"), undefined);
    assert.equal(parseTicketView(null), undefined);
    assert.equal(parseTicketSort("waiting"), "waiting");
    assert.equal(parseTicketSort("bogus"), "newest");
  });

  it("splits open tickets into claimed and unclaimed", () => {
    const open = ticket(1);
    const claimed = ticket(2, { claimedBy: "123456789012345678" });
    const closed = ticket(3, { status: "closed", claimedBy: "123456789012345678" });
    assert.equal(ticketMatchesView(open, "unclaimed"), true);
    assert.equal(ticketMatchesView(claimed, "unclaimed"), false);
    assert.equal(ticketMatchesView(claimed, "claimed"), true);
    assert.equal(ticketMatchesView(closed, "claimed"), false);
    assert.equal(ticketMatchesView(closed, "closed"), true);
    assert.equal(ticketMatchesView(closed, "all"), true);
  });

  it("knows when a ticket waits on staff and when its SLA fired", () => {
    const fresh = ticket(1);
    assert.deepEqual(ticketWaitInfo(fresh), { awaitingStaff: true, waitingSince: fresh.createdAt, slaBreached: false });
    const breached = ticket(2, { escalationStep: 0 });
    assert.equal(ticketWaitInfo(breached).slaBreached, true);
    // Staff replied last: waiting on the member, not staff.
    const answered = ticket(3, { lastStaffReplyAt: new Date(NOW - MIN), lastActivityAt: new Date(NOW - MIN) });
    assert.equal(ticketWaitInfo(answered).awaitingStaff, false);
    // On hold pauses the clock.
    assert.equal(ticketWaitInfo(ticket(4, { subStatus: "on_hold" })).awaitingStaff, false);
    assert.equal(ticketWaitInfo(ticket(5, { status: "closed" })).awaitingStaff, false);
  });

  it("sorts by newest, oldest, longest waiting and last activity", () => {
    const a = ticket(1, { lastActivityAt: new Date(NOW - 50 * MIN) });
    const b = ticket(2, { lastActivityAt: new Date(NOW - 1 * MIN) });
    const c = ticket(3, { lastStaffReplyAt: new Date(NOW), lastActivityAt: new Date(NOW) });
    const list = [a, b, c];
    assert.deepEqual(sortTickets(list, "newest").map((t) => t.id), [3, 2, 1]);
    assert.deepEqual(sortTickets(list, "oldest").map((t) => t.id), [1, 2, 3]);
    // a and b wait since they were created (b is older), c doesn't wait at all.
    assert.deepEqual(sortTickets(list, "waiting").map((t) => t.id), [2, 1, 3]);
    assert.deepEqual(sortTickets(list, "active").map((t) => t.id), [3, 2, 1]);
  });

  it("summarizes counts, recent closes, the 30-day strip and ratings", () => {
    const tickets = [
      ticket(1),
      ticket(2, { claimedBy: "1", escalationStep: 1 }),
      ticket(3, { status: "closed", closedAt: new Date(NOW - 2 * MIN), ratingScore: 5 }),
      ticket(4, { status: "closed", closedAt: new Date(NOW - 3 * DAY), ratingScore: 4 }),
      ticket(5, { status: "closed", createdAt: new Date(NOW - 40 * DAY), closedAt: new Date(NOW - 39 * DAY) }),
    ];
    const s = summarizeTickets(tickets, NOW);
    assert.deepEqual(s.byView, { open: 2, unclaimed: 1, claimed: 1, closed: 3, all: 5 });
    assert.equal(s.waitingOnStaff, 2);
    assert.equal(s.slaBreaches, 1);
    assert.equal(s.closedLast24h, 1);
    assert.equal(s.closedLast30d, 2);
    assert.equal(s.openedLast30d, 4);
    assert.equal(s.daily.length, 30);
    assert.equal(s.daily[29], 4);
    assert.equal(s.daily.reduce((a, b) => a + b, 0), 4);
    assert.deepEqual(s.satisfaction, { average: 4.5, count: 2 });
  });

  it("validates bulk requests", () => {
    assert.deepEqual(parseTicketBulkBody({ action: "close", ids: [3, "3", 4, -1, "x"], reason: "  done " }), {
      ids: [3, 4],
      action: "close",
      reason: "done",
      assigneeId: undefined,
    });
    assert.ok("error" in parseTicketBulkBody({ action: "explode", ids: [1] }));
    assert.ok("error" in parseTicketBulkBody({ action: "close", ids: [] }));
    assert.ok("error" in parseTicketBulkBody({ action: "assign", ids: [1] }));
    assert.ok("error" in parseTicketBulkBody({ action: "close", ids: Array.from({ length: 26 }, (_, i) => i + 1) }));
    const assign = parseTicketBulkBody({ action: "assign", ids: [1], assigneeId: "272397639855898624" });
    assert.ok(!("error" in assign) && assign.assigneeId === "272397639855898624");
  });

  it("formats a dashboard reply with the staff name and no markdown tricks in it", () => {
    const text = formatWebReply("**Coal** <@1>", "  Hi there!  ");
    assert.match(text, /^-# <:icons_reply:\d+> \*\*Coal 1\*\* replied from the dashboard\nHi there!$/);
    assert.match(formatWebReply("   ", "x"), /\*\*Staff\*\*/);
    assert.equal(formatWebReply("A", "y".repeat(5000)).split("\n")[1]!.length, 1800);
  });
});
