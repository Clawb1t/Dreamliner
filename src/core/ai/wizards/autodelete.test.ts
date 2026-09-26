import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { autodeleteWizard } from "./autodelete.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100000000000000001", name: "bot-commands" },
    { id: "100000000000000002", name: "memes" },
  ],
  categories: [],
  roles: [],
  emojis: [],
};

test("autodelete schema builds with $defs and strict rule objects", () => {
  const schema = autodeleteWizard.buildResultSchema(ctx) as Record<string, any>;
  assert.ok(schema.$defs.text_channel_id);
  const item = schema.properties.config.anyOf[1].properties.rules.items;
  assert.equal(item.additionalProperties, false);
  assert.ok("enabled" in item.properties);
});

test("autodelete validateConfig keeps one rule per real channel and clamps delay", () => {
  const config: Record<string, unknown> = {
    rules: [
      { channel_id: "100000000000000001", delay_seconds: 0, name: null, enabled: null },
      { channel_id: "nope", delay_seconds: 10, name: null, enabled: true },
      { channel_id: "100000000000000002", delay_seconds: 9_999_999, name: "Memes", enabled: false },
      { channel_id: "100000000000000001", delay_seconds: 30, name: null, enabled: null },
    ],
  };
  assert.equal(autodeleteWizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config.rules, [
    { channel_id: "100000000000000001", delay_seconds: 30, name: null, enabled: null },
    { channel_id: "100000000000000002", delay_seconds: 604_800, name: "Memes", enabled: false },
  ]);
  assert.ok(autodeleteWizard.validateConfig!({ rules: [{ channel_id: "x" }] }, ctx));
});
