import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANION_WIZARD_REGIONS, companionConfigSchema, companionWizard } from "./companion.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [{ id: "300", name: "Join to create" }],
  textChannels: [{ id: "100", name: "vc-logs" }],
  categories: [{ id: "400", name: "Rooms" }],
  roles: [{ id: "1", name: "Staff" }],
  emojis: [],
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys((companionConfigSchema() as { properties: object }).properties)) config[key] = null;
  return { ...config, hub_channel_id: "300", ...overrides };
}

test("schema builds with $defs and strict objects, never offers the literal automatic region", () => {
  const schema = companionWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs);
  assert.equal(schema.additionalProperties, false);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  assert.ok(!(COMPANION_WIZARD_REGIONS as readonly string[]).includes("automatic"));
  assert.ok("booster_bonus_user_limit" in (config.properties as object));
});

test("clamps numbers, maps automatic to empty, drops unknown ids, sanitizes features", () => {
  const config = base({
    user_limit: 150,
    booster_bonus_user_limit: -2,
    dynamic_ready: 0,
    region: "automatic",
    category_id: "999",
    log_channel_id: "100",
    staff_role_id: "404",
    join_role_id: "",
    features: { lock: false, nsfw: "yes", bogus: true },
  });
  assert.equal(companionWizard.validateConfig!(config, ctx), null);
  assert.equal(config.user_limit, 99);
  assert.equal(config.booster_bonus_user_limit, 0);
  assert.equal(config.dynamic_ready, 1);
  assert.equal(config.region, "");
  assert.equal(config.category_id, null);
  assert.equal(config.log_channel_id, "100");
  assert.equal(config.staff_role_id, null);
  assert.equal(config.join_role_id, "");
  const features = config.features as Record<string, unknown>;
  assert.equal(features.lock, false);
  assert.equal(features.nsfw, null);
  assert.ok(!("bogus" in features));
});

test("rejects a hub that isn't a real voice channel", () => {
  assert.match(companionWizard.validateConfig!(base({ hub_channel_id: "100" }), ctx)!, /voice channel/);
});
