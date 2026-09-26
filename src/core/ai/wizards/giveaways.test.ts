import { test } from "node:test";
import assert from "node:assert/strict";
import { giveawaysWizard } from "./giveaways.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100", name: "giveaway-log" }],
  categories: [],
  roles: [{ id: "1", name: "Giveaway Ping" }],
  emojis: [{ id: "555555555555555555", name: "tada2", animated: false }],
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
    log_channel_id: null,
    ping_role_id: null,
    default_entry_method: null,
    default_reaction_emoji: null,
    default_button_label: null,
    default_button_emoji: null,
    default_button_style: null,
    default_winner_count: null,
    default_embed: null,
    default_dm_winner: null,
    default_dm_non_winners: null,
    default_claim_window_minutes: null,
    default_require_role_mode: null,
    default_booster_bonus_weight: null,
    default_entry_cost: null,
    default_win_bonus: null,
    ...overrides,
  };
}

test("schema builds with $defs and strict objects everywhere", () => {
  const schema = giveawaysWizard.buildResultSchema(ctx);
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  assertStrict(schema);
});

test("an all-null result leaves everything null (nothing gets cleared)", () => {
  const config = base();
  assert.equal(giveawaysWizard.validateConfig!(config, ctx), null);
  assert.ok(Object.values(config).every((v) => v === null));
});

test("rejects unknown ids but accepts an empty id for none", () => {
  assert.ok(giveawaysWizard.validateConfig!(base({ log_channel_id: "42" }), ctx));
  assert.ok(giveawaysWizard.validateConfig!(base({ ping_role_id: "42" }), ctx));
  const config = base({ log_channel_id: "", ping_role_id: "1" });
  assert.equal(giveawaysWizard.validateConfig!(config, ctx), null);
  assert.equal(config.log_channel_id, "");
  assert.equal(config.ping_role_id, "1");
});

test("resolves emoji, clamps label and numbers, blank reaction emoji keeps the current one", () => {
  const config = base({
    default_reaction_emoji: "  ",
    default_button_emoji: "tada2",
    default_button_label: "E".repeat(100),
    default_winner_count: 0,
    default_claim_window_minutes: 999999,
    default_entry_cost: -3,
    default_embed: { enabled: null, title: "Giveaway!", color: null, fields: [{ name: "a", value: "b", inline: true }] },
  });
  assert.equal(giveawaysWizard.validateConfig!(config, ctx), null);
  assert.equal(config.default_reaction_emoji, null);
  assert.equal(config.default_button_emoji, "<:tada2:555555555555555555>");
  assert.equal((config.default_button_label as string).length, 80);
  assert.equal(config.default_winner_count, 1);
  assert.equal(config.default_claim_window_minutes, 10080);
  assert.equal(config.default_entry_cost, 0);
  assert.equal((config.default_embed as Record<string, unknown>).title, "Giveaway!");
});

test("prompt never uses em dashes", () => {
  assert.ok(!giveawaysWizard.buildSystemPrompt(ctx, 0).includes(String.fromCharCode(0x2014)));
});
