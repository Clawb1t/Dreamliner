import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { slowmodeWizard } from "./slowmode.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100000000000000001", name: "general" }],
  categories: [],
  roles: [{ id: "200000000000000001", name: "New" }],
  emojis: [],
};

const settings = {
  default_seconds: null,
  individual_enabled: null,
  allow_manage_messages_bypass: null,
  individual_default_seconds: null,
};

test("slowmode schema builds with $defs, default_seconds and rule list", () => {
  const schema = slowmodeWizard.buildResultSchema(ctx) as Record<string, any>;
  assert.ok(schema.$defs.role_id);
  assert.ok(schema.$defs.text_channel_id);
  const config = schema.properties.config.anyOf[1];
  assert.equal(config.additionalProperties, false);
  assert.ok("default_seconds" in config.properties);
  assert.equal(config.properties.rules.items.additionalProperties, false);
});

test("slowmode validateConfig checks targets, channels and de-duplicates", () => {
  const config: Record<string, unknown> = {
    ...settings,
    default_seconds: 50_000,
    rules: [
      { target: "role", target_id: "200000000000000001", seconds: 10, channels: ["100000000000000001"] },
      { target: "role", target_id: "200000000000000001", seconds: 30, channels: ["*", "100000000000000001"] },
      { target: "role", target_id: "999999999999999999", seconds: 10, channels: [] },
      { target: "user", target_id: "123456789012345678", seconds: 0, channels: [] },
      { target: "user", target_id: "someone", seconds: 5, channels: [] },
      { target: "user", target_id: "200000000000000001", seconds: 5, channels: [] },
      { target: "user", target_id: "123456789012345679", seconds: 5, channels: ["404"] },
    ],
  };
  assert.equal(slowmodeWizard.validateConfig!(config, ctx), null);
  assert.equal(config.default_seconds, 21_600);
  assert.deepEqual(config.rules, [
    { target: "role", target_id: "200000000000000001", seconds: 30, channels: ["*"] },
    { target: "user", target_id: "123456789012345678", seconds: 1, channels: ["*"] },
  ]);
});

test("slowmode validateConfig allows settings-only results and rejects empty ones", () => {
  assert.equal(slowmodeWizard.validateConfig!({ ...settings, individual_enabled: false, rules: [] }, ctx), null);
  assert.ok(slowmodeWizard.validateConfig!({ ...settings, rules: [] }, ctx));
});
