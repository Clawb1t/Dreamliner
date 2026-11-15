import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  duplicateReason,
  isSuggestionSort,
  isSuggestionState,
  parseBulkIds,
  stateColumns,
  suggestionState,
} from "./states.js";

describe("suggestion states", () => {
  it("folds status and display status into one state", () => {
    assert.equal(suggestionState("awaiting_review", "none"), "pending");
    assert.equal(suggestionState("denied", "implemented"), "denied");
    assert.equal(suggestionState("approved", "none"), "none");
    assert.equal(suggestionState("approved", "implemented"), "implemented");
    assert.equal(suggestionState("approved", "considered"), "considered");
    assert.equal(suggestionState("approved", "weird"), "none");
  });

  it("maps each state back to the columns it filters on", () => {
    assert.deepEqual(stateColumns("pending"), { status: "awaiting_review" });
    assert.deepEqual(stateColumns("denied"), { status: "denied" });
    assert.deepEqual(stateColumns("none"), { status: "approved", displayStatus: "none" });
    assert.deepEqual(stateColumns("no"), { status: "approved", displayStatus: "no" });
  });

  it("only accepts known states and sorts", () => {
    assert.ok(isSuggestionState("none"));
    assert.ok(!isSuggestionState("approved"));
    assert.ok(isSuggestionSort("status"));
    assert.ok(!isSuggestionSort("random"));
  });

  it("formats duplicate reasons", () => {
    assert.equal(duplicateReason(12), "Duplicate of #12");
    assert.equal(duplicateReason(12, "  same idea "), "Duplicate of #12: same idea");
  });

  it("parses bulk ids", () => {
    assert.deepEqual(parseBulkIds([3, "4", 3, -1, 2.5, "x", 0]), [3, 4]);
    assert.deepEqual(parseBulkIds("1,2"), []);
    assert.equal(parseBulkIds(Array.from({ length: 80 }, (_, i) => i + 1), 50).length, 50);
  });
});
