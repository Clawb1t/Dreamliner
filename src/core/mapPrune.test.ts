import { test } from "node:test";
import assert from "node:assert/strict";
import { capMap, createPruner } from "./mapPrune.js";

test("createPruner drops stale entries, at most once per interval", () => {
  const map = new Map<string, number>([
    ["old", 0],
    ["fresh", 9_000],
  ]);
  const prune = createPruner(map, (at, now) => now - at >= 5_000, 60_000);
  prune(10_000);
  assert.deepEqual([...map.keys()], ["fresh"]);
  map.set("old-again", 0);
  prune(20_000); // within the interval: no scan
  assert.ok(map.has("old-again"));
  prune(80_000);
  assert.equal(map.size, 0);
});

test("capMap keeps the newest entries under the cap", () => {
  const map = new Map<number, number>();
  for (let i = 0; i < 120; i++) map.set(i, i);
  capMap(map, 100);
  assert.ok(map.size <= 100);
  assert.ok(map.has(119));
  assert.ok(!map.has(0));
});
