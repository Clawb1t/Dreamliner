import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { autoreactionsWizard } from "./autoreactions.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100000000000000001", name: "general" }],
  categories: [],
  roles: [],
  emojis: [{ id: "500000000000000001", name: "blahaj", animated: true }],
};

const base = {
  channel_id: "100000000000000001",
  trigger: "every_message",
  match: "",
  every_n: null,
  cooldown_seconds: null,
  attachments_only: null,
  links_only: null,
  emoji: "👍",
};

test("autoreactions schema builds with $defs and strict objects", () => {
  const schema = autoreactionsWizard.buildResultSchema(ctx) as Record<string, any>;
  assert.ok(schema.$defs.text_channel_id);
  const item = schema.properties.config.anyOf[1].properties.rules.items;
  assert.equal(item.additionalProperties, false);
  assert.ok("every_n" in item.properties);
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
});

test("autoreactions validateConfig resolves emoji and clamps", () => {
  const config: Record<string, unknown> = {
    rules: [
      { ...base, emoji: ":blahaj:", every_n: 5000 },
      { ...base, emoji: "  " },
      { ...base, trigger: "contains", match: "" },
      { ...base, trigger: "regex", match: "\\bhi\\b", cooldown_seconds: -3 },
    ],
  };
  assert.equal(autoreactionsWizard.validateConfig!(config, ctx), null);
  const rules = config.rules as Record<string, any>[];
  assert.equal(rules.length, 2);
  assert.equal(rules[0].emoji, "<a:blahaj:500000000000000001>");
  assert.equal(rules[0].every_n, 1000);
  assert.equal(rules[1].cooldown_seconds, 0);
});

test("autoreactions validateConfig errors with no usable rule", () => {
  assert.ok(autoreactionsWizard.validateConfig!({ rules: [] }, ctx));
});
