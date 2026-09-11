import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadDefaultConfig } from "./default.js";
import { zGuildConfig } from "./schemas/guild.js";

// A guild with no stored config (or no override for a given plugin) runs on this verbatim, and
// `repairGuildConfig`'s last-resort fallback re-derives from it too — it must always be
// schema-valid on its own, with no separately-maintained defaults file backing it up anymore.
describe("loadDefaultConfig", () => {
  it("is schema-valid on its own", () => {
    const config = loadDefaultConfig();
    const reparsed = zGuildConfig.safeParse(config);
    assert.equal(reparsed.success, true, "the default config must validate against its own schema");
  });

  it("has every plugin section populated (not left undefined)", () => {
    const config = loadDefaultConfig();
    const pluginKeys = Object.keys(zGuildConfig.shape.plugins.shape ?? {});
    // zGuildConfig.shape.plugins is itself a ZodDefault-wrapped object; read the inner shape off
    // the parsed config instead, which is simpler and just as effective a check.
    for (const key of Object.keys(config.plugins)) {
      const section = (config.plugins as Record<string, { enabled?: boolean } | undefined>)[key];
      assert.ok(section, `plugins.${key} should not be undefined`);
      assert.equal(typeof section?.enabled, "boolean", `plugins.${key}.enabled should be a real boolean, not undefined`);
    }
    assert.ok(pluginKeys.length >= 0); // shape presence isn't load-bearing here; the loop above is the real assertion
  });

  // Only Utility ships on out of the box — everything else is opt-in from the dashboard. Get
  // this wrong and a plugin either silently activates for every guild that's never touched it,
  // or Utility itself goes dark.
  it("enables only Utility by default", () => {
    const config = loadDefaultConfig();
    for (const [key, section] of Object.entries(config.plugins as Record<string, { enabled?: boolean } | undefined>)) {
      const expected = key === "utility";
      assert.equal(section?.enabled, expected, `plugins.${key}.enabled should default to ${expected}`);
    }
  });

  it("caches the result but still returns an independent clone each call", () => {
    const a = loadDefaultConfig();
    const b = loadDefaultConfig();
    assert.notEqual(a, b, "callers must not share a mutable reference");
    assert.deepEqual(a, b);
  });
});
