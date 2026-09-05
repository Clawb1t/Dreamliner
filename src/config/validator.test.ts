import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairGuildConfig } from "./validator.js";
import { zGuildConfig } from "./schemas/guild.js";

describe("repairGuildConfig", () => {
  it("always converges to a schema-valid config, no matter how broken the input", () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      "not an object at all",
      [1, 2, 3],
      { emojis: "nope", levels: "also nope", command_prefix: 42 },
      { plugins: { starboard: { config: { boards: "nope" } } } },
      {
        plugins: {
          automod: { config: { rules: [{ nonsense: true }] } },
          starboard: "totally wrong type",
        },
        levels: { "123": "not a number" },
      },
      { totally_made_up_key: { a: 1 } },
    ];

    for (const value of cases) {
      const result = repairGuildConfig(value);
      assert.equal(result.success, true, `expected repair to succeed for ${JSON.stringify(value)}`);
      if (result.success) {
        const reparsed = zGuildConfig.safeParse(result.data);
        assert.equal(reparsed.success, true, `repaired data should itself validate for ${JSON.stringify(value)}`);
      }
    }
  });

  it("keeps valid customizations untouched", () => {
    const result = repairGuildConfig({ plugins: { starboard: { enabled: false } } });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.plugins.starboard?.enabled, false);
    }
  });

  it("strips only the broken fragment, not the whole plugin section", () => {
    const result = repairGuildConfig({
      plugins: {
        starboard: {
          enabled: true,
          config: {
            boards: {
              main: { channel_id: "123", stars_required: 3, unknown_legacy_key: true },
            },
          },
        },
      },
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.plugins.starboard?.enabled, true);
      assert.equal(result.data.plugins.starboard?.config?.boards?.main?.channel_id, "123");
    }
  });

  it("drops only the one invalid ticket panel, not every panel in the section", () => {
    // The category's blank label only fails a superRefine custom issue, not a plain zod-level
    // constraint — so deleting just the invalid leaf re-defaults right back to the same invalid
    // value ("" for label) instead of fixing anything, which then cascades into a second issue
    // (an empty categories array fails its own min(1)). Regression test for that getting
    // misdiagnosed as "no progress" and escalating to a full plugins.tickets reset, which used to
    // wipe every other panel along with the one that was actually broken.
    const goodCategory = {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Support",
      category_channel_id: "999",
    };
    const brokenCategory = {
      id: "22222222-2222-4222-8222-222222222222",
      label: "", // fails the "give this category a label" superRefine check
      category_channel_id: "999",
    };
    const result = repairGuildConfig({
      plugins: {
        tickets: {
          config: {
            panels: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                channel_id: "111",
                categories: [goodCategory],
              },
              {
                id: "44444444-4444-4444-8444-444444444444",
                channel_id: "222",
                categories: [brokenCategory],
              },
            ],
          },
        },
      },
    });
    assert.equal(result.success, true);
    if (result.success) {
      const panels = result.data.plugins.tickets?.config?.panels ?? [];
      // The good panel survives untouched...
      assert.ok(panels.some((p) => p.id === "33333333-3333-4333-8333-333333333333"));
      // ...and only the one panel that couldn't be fixed (its only category was unfixably
      // invalid, leaving it with none) was dropped — not the whole tickets section.
      assert.ok(!panels.some((p) => p.id === "44444444-4444-4444-8444-444444444444"));
    }
  });
});
