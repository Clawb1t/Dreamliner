import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestionThreadName } from "./thread.js";

const suggestion = { suggestionNumber: 12, content: "Add a music channel\nwith a queue bot", anonymous: false };

test("fills the thread name placeholders", () => {
  assert.equal(suggestionThreadName("Suggestion #{number}", suggestion, "Clawbit"), "Suggestion #12");
  assert.equal(
    suggestionThreadName("#{number} by {author}: {content}", suggestion, "Clawbit"),
    "#12 by Clawbit: Add a music channel",
  );
});

test("never names an anonymous suggestion's author", () => {
  assert.equal(suggestionThreadName("{author}", { ...suggestion, anonymous: true }, "Clawbit"), "Anonymous");
});

test("falls back when the template renders empty, and caps the length", () => {
  assert.equal(suggestionThreadName("   ", suggestion, "Clawbit"), "Suggestion #12");
  assert.equal(suggestionThreadName("x".repeat(150), suggestion, "Clawbit").length, 100);
});
