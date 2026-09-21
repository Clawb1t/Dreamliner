import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escalationSilenceStart, isAwaitingStaffReply } from "./escalation.js";

const HOUR = 60 * 60 * 1000;

function ticket(fields: {
  subStatus?: "in_progress" | "awaiting_response" | "awaiting_info" | "on_hold" | null;
  lastStaffReplyAt?: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
}) {
  return { subStatus: fields.subStatus ?? null, ...fields };
}

describe("ticket escalation: who is being waited on", () => {
  it("is awaiting staff when staff has never replied", () => {
    const now = new Date();
    const t = ticket({ lastStaffReplyAt: null, lastActivityAt: now, createdAt: now });
    assert.equal(isAwaitingStaffReply(t), true);
    assert.equal(escalationSilenceStart(t), t.createdAt);
  });

  it("is NOT awaiting staff right after staff replies and nobody has answered since", () => {
    const staffReply = new Date();
    const t = ticket({
      lastStaffReplyAt: staffReply,
      lastActivityAt: staffReply, // touchStaffReply bumps both to the same timestamp
      createdAt: new Date(staffReply.getTime() - HOUR),
    });
    assert.equal(isAwaitingStaffReply(t), false);
  });

  it("is awaiting staff again once the member replies after staff's last message", () => {
    const staffReply = new Date(Date.now() - HOUR);
    const memberReply = new Date();
    const t = ticket({ lastStaffReplyAt: staffReply, lastActivityAt: memberReply, createdAt: new Date(staffReply.getTime() - HOUR) });
    assert.equal(isAwaitingStaffReply(t), true);
    // Silence should be measured from the member's follow-up, not staff's older reply.
    assert.equal(escalationSilenceStart(t), memberReply);
  });

  it("blocks escalation while on hold, even if the member is technically waiting on staff", () => {
    const memberReply = new Date();
    const t = ticket({
      subStatus: "on_hold",
      lastStaffReplyAt: new Date(memberReply.getTime() - HOUR),
      lastActivityAt: memberReply,
      createdAt: new Date(memberReply.getTime() - 2 * HOUR),
    });
    assert.equal(isAwaitingStaffReply(t), false);
  });

  it("blocks escalation while awaiting_response (staff is waiting on the member)", () => {
    const staffReply = new Date();
    const t = ticket({ subStatus: "awaiting_response", lastStaffReplyAt: staffReply, lastActivityAt: staffReply, createdAt: new Date(staffReply.getTime() - HOUR) });
    assert.equal(isAwaitingStaffReply(t), false);
  });

  it("blocks escalation while awaiting_info (staff asked the member for more details)", () => {
    const staffReply = new Date();
    const t = ticket({ subStatus: "awaiting_info", lastStaffReplyAt: staffReply, lastActivityAt: staffReply, createdAt: new Date(staffReply.getTime() - HOUR) });
    assert.equal(isAwaitingStaffReply(t), false);
  });

  it("does not block escalation while in_progress", () => {
    const staffReply = new Date(Date.now() - HOUR);
    const memberReply = new Date();
    const t = ticket({ subStatus: "in_progress", lastStaffReplyAt: staffReply, lastActivityAt: memberReply, createdAt: new Date(staffReply.getTime() - HOUR) });
    assert.equal(isAwaitingStaffReply(t), true);
  });
});
