import { test } from "node:test";
import assert from "node:assert/strict";
import { starboardWizard } from "./starboard.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100", name: "starboard" },
    { id: "101", name: "staff" },
  ],
  categories: [],
  roles: [{ id: "1", name: "Muted" }],
  emojis: [{ id: "555555555555555555", name: "goldstar", animated: true }],
};

/** Every object in a strict-mode schema must list all its keys as required and forbid extras. */
function assertStrict(node: unknown, path = "root"): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${path}[${i}]`));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === "object" || (Array.isArray(o.type) && o.type.includes("object"))) {
    assert.equal(o.additionalProperties, false, `${path} allows extra properties`);
    assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties as object).sort(), `${path} required`);
  }
  for (const [k, v] of Object.entries(o)) assertStrict(v, `${path}.${k}`);
}

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: null,
    channel_id: "100",
    enabled: null,
    stars_required: null,
    star_emoji: null,
    show_star_count: null,
    copy_full_embed: null,
    count_self_stars: null,
    ignored_channels: null,
    ignored_roles: null,
    allow_bot_messages: null,
    allow_nsfw: null,
    color: null,
    economy_bonus: null,
    global: null,
    ...overrides,
  };
}

test("schema builds with $defs and strict objects everywhere", () => {
  const schema = starboardWizard.buildResultSchema(ctx);
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  assertStrict(schema);
});

test("needs a real board channel", () => {
  assert.match(starboardWizard.validateConfig!(base({ channel_id: "42" }), ctx) ?? "", /channel/);
});

test("resolves custom star emoji and falls back to a star when emptied", () => {
  const config = base({ star_emoji: ["goldstar", "goldstar", "⭐"] });
  assert.equal(starboardWizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config.star_emoji, ["<a:goldstar:555555555555555555>", "⭐"]);

  const empty = base({ star_emoji: ["", "  "] });
  assert.equal(starboardWizard.validateConfig!(empty, ctx), null);
  assert.deepEqual(empty.star_emoji, ["⭐"]);

  const untouched = base();
  assert.equal(starboardWizard.validateConfig!(untouched, ctx), null);
  assert.equal(untouched.star_emoji, null);
});

test("sanitizes board and global filters, keeps nulls", () => {
  const config = base({
    name: "Best Memes!",
    stars_required: 0,
    ignored_channels: ["101", "999"],
    ignored_roles: ["1", "2"],
    color: -5,
    economy_bonus: -10,
    global: { ignored_channels: null, ignored_roles: ["1"], allow_bot_messages: true, allow_nsfw: null, color: 20000000 },
  });
  assert.equal(starboardWizard.validateConfig!(config, ctx), null);
  assert.equal(config.name, "best_memes");
  assert.equal(config.stars_required, 1);
  assert.deepEqual(config.ignored_channels, ["101"]);
  assert.deepEqual(config.ignored_roles, ["1"]);
  assert.equal(config.color, 0);
  assert.equal(config.economy_bonus, 0);
  const global = config.global as Record<string, unknown>;
  assert.equal(global.ignored_channels, null);
  assert.equal(global.allow_bot_messages, true);
  assert.equal(global.allow_nsfw, null);
  assert.equal(global.color, 0xffffff);
});

test("prompt never uses em dashes", () => {
  assert.ok(!starboardWizard.buildSystemPrompt(ctx, 0).includes(String.fromCharCode(0x2014)));
});
