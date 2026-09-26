import { test } from "node:test";
import assert from "node:assert/strict";
import { countingConfigSchema, countingWizard } from "./counting.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100", name: "counting" }],
  categories: [],
  roles: [{ id: "1", name: "Muted" }],
  emojis: [{ id: "555555", name: "yay", animated: false }],
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys((countingConfigSchema() as { properties: object }).properties)) config[key] = null;
  return { ...config, channel_id: "100", ...overrides };
}

test("schema builds with $defs and strict objects", () => {
  const schema = countingWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs);
  assert.equal(schema.additionalProperties, false);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  assert.ok("economy_milestone_bonus" in (config.properties as object));
});

test("sanitizes numbers, emojis, roles and webhook url; keeps nulls", () => {
  const config = base({
    step: 5000,
    cooldown_seconds: -1,
    economy_milestone_bonus: -10,
    success_reaction: ":yay:",
    failure_reaction: "",
    ignored_roles: ["1", "2"],
    webhook_avatar_url: "http://insecure.example/a.png",
    failure_message: "x".repeat(400),
  });
  assert.equal(countingWizard.validateConfig!(config, ctx), null);
  assert.equal(config.step, 1000);
  assert.equal(config.cooldown_seconds, 0);
  assert.equal(config.economy_milestone_bonus, 0);
  assert.equal(config.success_reaction, "<:yay:555555>");
  assert.equal(config.failure_reaction, "");
  assert.equal(config.milestone_reaction, null);
  assert.deepEqual(config.ignored_roles, ["1"]);
  assert.equal(config.allowed_roles, null);
  assert.equal(config.webhook_avatar_url, null);
  assert.equal((config.failure_message as string).length, 300);
  assert.equal(config.start_at, null);
});

test("last_milestone reset without milestones falls back to zero", () => {
  const config = base({ reset_to: "last_milestone", milestone_every: 0 });
  assert.equal(countingWizard.validateConfig!(config, ctx), null);
  assert.equal(config.reset_to, "zero");
  const kept = base({ reset_to: "last_milestone", milestone_every: null });
  countingWizard.validateConfig!(kept, ctx);
  assert.equal(kept.reset_to, "last_milestone");
});

test("rejects unknown channels", () => {
  assert.match(countingWizard.validateConfig!(base({ channel_id: "404" }), ctx)!, /channel/);
});
