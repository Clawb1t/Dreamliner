import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { welcomeWizard } from "./welcome.js";

const ctx: AiWizardContext = {
  guildName: "Test Server",
  voiceChannels: [],
  textChannels: [{ id: "100000000000000001", name: "welcome" }],
  categories: [],
  roles: [{ id: "200000000000000001", name: "Member" }],
  emojis: [{ id: "300000000000000001", name: "blahaj", animated: false }],
};

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node)) walk(value, visit);
}

test("welcome schema has $defs and every object is strict", () => {
  const schema = welcomeWizard.buildResultSchema(ctx);
  const defs = schema.$defs as Record<string, unknown>;
  assert.ok(defs.text_channel_id && defs.welcome_embed && defs.welcome_card);
  walk(schema, (n) => {
    if (n.type === "object") {
      assert.equal(n.additionalProperties, false);
      assert.deepEqual(n.required, Object.keys(n.properties as object));
    }
  });
});

test("welcome prompt lists emoji and never uses em dashes", () => {
  const prompt = welcomeWizard.buildSystemPrompt(ctx, 0);
  assert.match(prompt, /blahaj/);
  assert.ok(!prompt.includes(String.fromCharCode(0x2014)));
});

test("welcome validateConfig sanitizes without clobbering", () => {
  const config: Record<string, unknown> = {
    join: {
      enabled: true,
      channel_id: "999999999999999999",
      content: "x".repeat(3000),
      embed: null,
      card: { enabled: true, border_width: 99, avatar_size: 10, background_type: "url", background_url: "" },
    },
    leave: { enabled: false, channel_id: "", content: null, embed: null, card: null },
    dm: null,
    wave_button: { enabled: true, label: "", emoji: "blahaj" },
    first_message_react: { enabled: true, emoji: ":blahaj:" },
    delete_join_on_early_leave: null,
    require_passport_verification: true,
    member_milestones: {
      enabled: true,
      channel_id: "100000000000000001",
      content: null,
      embed: { enabled: true, color: 99999999, fields: [{ name: "", value: "", inline: false }] },
      card: null,
      milestones: [
        { count: 1, enabled: null, name: null, channel_id: null, message_mode: null, message: null },
        { count: 1000, enabled: true, name: "1k", channel_id: "nope", message_mode: "custom", message: null },
        { count: 1000, enabled: true, name: "dupe", channel_id: null, message_mode: null, message: null },
      ],
    },
  };
  assert.equal(welcomeWizard.validateConfig!(config, ctx), null);
  const join = config.join as Record<string, unknown>;
  assert.equal(join.channel_id, null, "unknown channel becomes unchanged");
  assert.equal((join.content as string).length, 2000);
  const card = join.card as Record<string, unknown>;
  assert.equal(card.border_width, 32);
  assert.equal(card.avatar_size, 64);
  assert.equal(card.background_type, null, "url background with an empty url is dropped");
  assert.equal((config.leave as Record<string, unknown>).channel_id, "");
  assert.deepEqual(config.wave_button, { enabled: true, label: null, emoji: "<:blahaj:300000000000000001>" });
  assert.equal((config.first_message_react as Record<string, unknown>).emoji, "<:blahaj:300000000000000001>");
  const mm = config.member_milestones as Record<string, unknown>;
  assert.equal((mm.embed as Record<string, unknown>).color, 0xffffff);
  assert.deepEqual((mm.embed as Record<string, unknown>).fields, []);
  const milestones = mm.milestones as Record<string, unknown>[];
  assert.deepEqual(
    milestones.map((m) => m.count),
    [2, 1000],
    "counts are clamped and de-duplicated",
  );
  assert.equal(milestones[1]!.name, "dupe");
  assert.equal(milestones[1]!.channel_id, null);
});
