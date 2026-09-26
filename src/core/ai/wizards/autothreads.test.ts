import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { autothreadsWizard } from "./autothreads.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100000000000000001", name: "support" }],
  categories: [],
  roles: [],
  emojis: [],
};

test("autothreads schema builds with $defs and covers every rule field", () => {
  const schema = autothreadsWizard.buildResultSchema(ctx) as Record<string, any>;
  assert.ok(schema.$defs.text_channel_id);
  const item = schema.properties.config.anyOf[1].properties.rules.items;
  assert.equal(item.additionalProperties, false);
  for (const key of [
    "thread_slowmode_seconds",
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

test("autothreads validateConfig sanitizes thread settings and embed", () => {
  const config: Record<string, unknown> = {
    rules: [
      {
        channel_id: "100000000000000001",
        trigger: "every_message",
        match: "",
        every_n: null,
        cooldown_seconds: null,
        attachments_only: null,
        links_only: null,
        thread_name: "  ",
        auto_archive_minutes: 42,
        thread_slowmode_seconds: 50_000,
        response: "",
        embed: {
          enabled: true,
          title: "t".repeat(400),
          color: -5,
          author_icon: "weird",
          fields: [{ name: "", value: "", inline: false }],
        },
        buttons: null,
        webhook: null,
        webhook_name: null,
        webhook_avatar_url: null,
        silent: null,
        suppress_embeds: null,
        mention_users: null,
        mention_roles: null,
        mention_everyone: null,
      },
    ],
  };
  assert.equal(autothreadsWizard.validateConfig!(config, ctx), null);
  const [rule] = config.rules as Record<string, any>[];
  assert.equal(rule.thread_name, null);
  assert.equal(rule.auto_archive_minutes, null);
  assert.equal(rule.thread_slowmode_seconds, 21_600);
  assert.equal(rule.embed.title.length, 256);
  assert.equal(rule.embed.color, 0);
  assert.equal(rule.embed.author_icon, null);
  assert.deepEqual(rule.embed.fields, []);
});
