import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStaffPing, ON_SHIFT_PING_LIMIT, pickOnShiftStaff } from "./onShift.js";

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 15, 12, 0) - minutesAgo * 60_000);
const shift = (userId: string, minutesAgo: number, onBreak = false) => ({
  userId,
  startedAt: at(minutesAgo),
  breakStartedAt: onBreak ? at(1) : null,
});

describe("pickOnShiftStaff", () => {
  it("skips staff on a break or on leave, longest shift first", () => {
    const shifts = [shift("a", 10), shift("b", 60, true), shift("c", 90), shift("d", 30)];
    assert.deepEqual(pickOnShiftStaff(shifts, new Set(["d"])), ["c", "a"]);
  });

  it("returns nobody when nobody is available", () => {
    assert.deepEqual(pickOnShiftStaff([], new Set()), []);
    assert.deepEqual(pickOnShiftStaff([shift("a", 5, true)], new Set()), []);
  });

  it("caps the page", () => {
    const shifts = Array.from({ length: 12 }, (_, i) => shift(`u${i}`, 100 - i));
    const picked = pickOnShiftStaff(shifts, new Set());
    assert.equal(picked.length, ON_SHIFT_PING_LIMIT);
    assert.deepEqual(picked, ["u0", "u1", "u2", "u3", "u4"]);
    assert.equal(pickOnShiftStaff(shifts, new Set(), { limit: 2 }).length, 2);
  });

  it("prefers on-shift holders of the role, else everyone on shift", () => {
    const shifts = [shift("a", 50), shift("b", 40), shift("c", 30)];
    assert.deepEqual(pickOnShiftStaff(shifts, new Set(), { preferredUserIds: new Set(["c", "x"]) }), ["c"]);
    assert.deepEqual(pickOnShiftStaff(shifts, new Set(), { preferredUserIds: new Set(["x"]) }), ["a", "b", "c"]);
    // A preferred member on leave doesn't count as available.
    assert.deepEqual(pickOnShiftStaff(shifts, new Set(["c"]), { preferredUserIds: new Set(["c"]) }), ["a", "b"]);
  });

  it("dedupes a user with two shift rows", () => {
    assert.deepEqual(pickOnShiftStaff([shift("a", 50), shift("a", 20)], new Set()), ["a"]);
  });
});

describe("buildStaffPing", () => {
  it("pings only the picked users when on shift", () => {
    const ping = buildStaffPing(["1", "2"], ["9"], true);
    assert.equal(ping.content, "<@1> <@2>");
    assert.deepEqual(ping.allowedMentions, { users: ["1", "2"], roles: [], parse: [] });
  });

  it("falls back to the roles", () => {
    const ping = buildStaffPing([], ["9", "9", "8"], false);
    assert.equal(ping.content, "<@&9> <@&8>");
    assert.deepEqual(ping.allowedMentions, { users: [], roles: ["9", "8"], parse: [] });
    assert.equal(buildStaffPing([], [], false).content, "");
  });
});
