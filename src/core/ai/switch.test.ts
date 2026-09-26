import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportDirective, isSwitchSource, withMoreToImport } from "./switch.js";
import { mee6XpForLevel, mee6XpToMessages } from "../../bridge/webSwitch.js";

test("MEE6 level curve matches 5L^2 + 50L + 100 per level", () => {
  assert.equal(mee6XpForLevel(0), 0);
  assert.equal(mee6XpForLevel(1), 100);
  assert.equal(mee6XpForLevel(2), 255);
  assert.equal(mee6XpForLevel(3), 475);
  // Level 101 -> 102 costs 56155 XP, as seen live in MEE6's detailed_xp.
  assert.equal(mee6XpForLevel(102) - mee6XpForLevel(101), 56155);
});

test("XP becomes roughly one message per 20 XP", () => {
  assert.equal(mee6XpToMessages(0), 0);
  assert.equal(mee6XpToMessages(19), 1);
  assert.equal(mee6XpToMessages(2000), 100);
  assert.equal(mee6XpToMessages(-5), 0);
});

test("withMoreToImport adds a required boolean without touching the wizard's fields", () => {
  const base = { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false };
  const extended = withMoreToImport(base);
  assert.deepEqual(extended.required, ["action", "more_to_import"]);
  assert.deepEqual((extended.properties as Record<string, unknown>).more_to_import, { type: "boolean" });
  assert.deepEqual(base.required, ["action"], "original schema is not mutated");
});

test("import directive names the source and page, and never uses em dashes", () => {
  const directive = buildImportDirective("mee6", "Welcome & Goodbye");
  assert.match(directive, /MEE6/);
  assert.match(directive, /Welcome & Goodbye/);
  assert.ok(!directive.includes("—"));
  assert.ok(isSwitchSource("dyno"));
  assert.ok(isSwitchSource("yagpdb") && isSwitchSource("carl") && isSwitchSource("tatsu"));
  assert.ok(!isSwitchSource("not-a-bot"));
});
