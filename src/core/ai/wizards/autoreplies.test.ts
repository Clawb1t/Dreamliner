import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { autorepliesWizard } from "./autoreplies.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100000000000000001", name: "general" }],
  categories: [],
  roles: [{ id: "200000000000000001", name: "Members" }],
  emojis: [{ id: "500000000000000001", name: "blahaj", animated: false }],
};

function rule(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    channel_id: "",
    trigger: "contains",
    match: "hi",
    every_n: null,
    cooldown_seconds: null,
    attachments_only: null,
    links_only: null,
    response: "Hello!",
    reply_to_message: null,
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
    ...overrides,
  };
}

test("autoreplies schema builds with $defs and strict objects", () => {
  const schema = autorepliesWizard.buildResultSchema(ctx) as Record<string, any>;
  assert.ok(schema.$defs.text_channel_id);
  assert.equal(schema.additionalProperties, false);
  const config = schema.properties.config.anyOf[1];
  assert.equal(config.additionalProperties, false);
  const item = config.properties.rules.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
  for (const key of [
    "every_n",
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
  ]) {
    assert.ok(key in item.properties, key);
  }
});

test("autoreplies validateConfig sanitizes and drops unusable rules", () => {
  const config: Record<string, unknown> = {
    rules: [
      rule({ match: "x".repeat(300), response: "y".repeat(2500), every_n: 1, cooldown_seconds: 999_999 }),
      rule({ channel_id: "999" }),
      rule({ trigger: "regex", match: "(unclosed" }),
      rule({ trigger: "every_message", match: "ignored", webhook_name: "n".repeat(100) }),
      rule({ response: "", embed: null, buttons: null }),
      rule({
        response: "",
        buttons: [
          { label: "Docs", url: "https://example.com", emoji: "blahaj" },
          { label: "Bad", url: "javascript:alert(1)", emoji: "" },
        ],
      }),
    ],
  };
  assert.equal(autorepliesWizard.validateConfig!(config, ctx), null);
  const rules = config.rules as Record<string, any>[];
  assert.equal(rules.length, 3);
  assert.equal(rules[0].match.length, 200);
  assert.equal(rules[0].response.length, 2000);
  assert.equal(rules[0].every_n, 0);
  assert.equal(rules[0].cooldown_seconds, 86_400);
  assert.equal(rules[1].match, "");
  assert.equal(rules[1].webhook_name.length, 80);
  assert.deepEqual(rules[2].buttons, [
    { label: "Docs", url: "https://example.com", emoji: "<:blahaj:500000000000000001>" },
  ]);
});

test("autoreplies validateConfig errors when nothing usable is left", () => {
  const error = autorepliesWizard.validateConfig!({ rules: [rule({ channel_id: "999" })] }, ctx);
  assert.match(error ?? "", /channel/);
});

test("autoreplies prompt never uses em dashes", () => {
  assert.ok(!autorepliesWizard.buildSystemPrompt(ctx, 0).includes(String.fromCharCode(0x2014)));
});
