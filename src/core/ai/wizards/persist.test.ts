import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { persistWizard } from "./persist.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100000000000000001", name: "general" }],
  categories: [],
  roles: [],
  emojis: [],
};

function sticky(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    channel_id: "100000000000000001",
    content: "Read the rules",
    name: null,
    enabled: null,
    delay_seconds: null,
    message_threshold: null,
    embed: null,
    buttons: null,
    webhook: null,
    webhook_name: null,
    webhook_avatar_url: null,
    silent: null,
    suppress_embeds: null,
    mention_users: null,
    mention_roles: null,
    mention_everyone: null,
    ignore_bots: null,
    ignore_webhooks: null,
    ...overrides,
  };
}

test("persist schema builds with $defs and covers every sticky field", () => {
  const schema = persistWizard.buildResultSchema(ctx) as Record<string, any>;
  assert.ok(schema.$defs.text_channel_id);
  const config = schema.properties.config.anyOf[1];
  assert.equal(config.additionalProperties, false);
  for (const key of [
    "enabled",
    "embed",
    "buttons",
    "webhook",
    "webhook_name",
    "webhook_avatar_url",
    "silent",
    "suppress_embeds",
    "mention_users",
    "mention_roles",
    "mention_everyone",
    "ignore_bots",
    "ignore_webhooks",
  ]) {
    assert.ok(key in config.properties, key);
  }
});

test("persist accepts embed-only and button-only stickies", () => {
  const embedOnly = sticky({ content: "", embed: { enabled: true, title: "Rules", description: null, fields: null } });
  assert.equal(persistWizard.validateConfig!(embedOnly, ctx), null);
  const buttonOnly = sticky({ content: "", buttons: [{ label: "Site", url: "https://example.com", emoji: "" }] });
  assert.equal(persistWizard.validateConfig!(buttonOnly, ctx), null);
  const empty = sticky({ content: "  ", embed: { enabled: false, title: "Rules" } });
  assert.ok(persistWizard.validateConfig!(empty, ctx));
});

test("persist validateConfig clamps timing and rejects unknown channels", () => {
  const config = sticky({ delay_seconds: 100_000, message_threshold: -1, name: "n".repeat(100) });
  assert.equal(persistWizard.validateConfig!(config, ctx), null);
  assert.equal(config.delay_seconds, 86_400);
  assert.equal(config.message_threshold, 0);
  assert.equal((config.name as string).length, 80);
  assert.ok(persistWizard.validateConfig!(sticky({ channel_id: "1" }), ctx));
});
