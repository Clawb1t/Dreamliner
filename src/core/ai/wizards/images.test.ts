import { test } from "node:test";
import assert from "node:assert/strict";
import { imagesWizard } from "./images.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100", name: "cats" },
    { id: "101", name: "dogs" },
  ],
  categories: [],
  roles: [],
  emojis: [],
};

test("schema builds with $defs and strict objects", () => {
  const schema = imagesWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
});

test("keeps several sends, normalizes time, drops bad timezones and channels", () => {
  const config: Record<string, unknown> = {
    daily: [
      { channel_id: "100", source: "cat", time: "9:30", timezone: "Europe/London", enabled: null },
      { channel_id: "101", source: "dog", time: "25:00", timezone: "Mars/Olympus", enabled: false },
      { channel_id: "404", source: "fox", time: "12:00", timezone: "UTC", enabled: null },
    ],
  };
  assert.equal(imagesWizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config.daily, [
    { channel_id: "100", source: "cat", time: "09:30", timezone: "Europe/London", enabled: null },
    { channel_id: "101", source: "dog", time: null, timezone: null, enabled: false },
  ]);
});

test("rejects a result with no real channel", () => {
  assert.match(imagesWizard.validateConfig!({ daily: [{ channel_id: "404", source: "cat" }] }, ctx)!, /channel/);
});
