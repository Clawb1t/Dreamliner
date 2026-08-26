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
});
