import { test } from "node:test";
import assert from "node:assert/strict";
import { countersWizard } from "./counters.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [{ id: "300", name: "Members" }],
  textChannels: [{ id: "100", name: "stats" }],
  categories: [],
  roles: [],
  emojis: [],
};

function counter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metric: "members",
    display: "voice_name",
    channel_id: "300",
    name: null,
    enabled: null,
    format: null,
    refresh_minutes: null,
    value: null,
    ...overrides,
  };
}

test("schema builds with $defs and strict objects", () => {
  const schema = countersWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs);
  assert.equal(schema.additionalProperties, false);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
});

test("keeps several counters, drops mismatched channels, clamps numbers", () => {
  const config = {
    counters: [
      counter({ format: "Members: {value}", refresh_minutes: 1 }),
      counter({ metric: "boosts", display: "message", channel_id: "300" }),
      counter({ metric: "custom", display: "message", channel_id: "100", value: -4, enabled: false, name: "x".repeat(100) }),
    ],
  };
  assert.equal(countersWizard.validateConfig!(config, ctx), null);
  const counters = config.counters as Record<string, unknown>[];
  assert.equal(counters.length, 2);
  assert.equal(counters[0]!.refresh_minutes, 5);
  assert.equal(counters[0]!.format, "Members: {value}");
  assert.equal(counters[1]!.value, 0);
  assert.equal(counters[1]!.enabled, false);
  assert.equal((counters[1]!.name as string).length, 80);
  assert.equal(counters[1]!.refresh_minutes, null);
});

test("rejects a result with no usable counter", () => {
  assert.match(countersWizard.validateConfig!({ counters: [counter({ channel_id: "100" })] }, ctx)!, /channel/);
  assert.match(countersWizard.validateConfig!({ counters: [] }, ctx)!, /channel/);
});
