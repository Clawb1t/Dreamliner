import { test } from "node:test";
import assert from "node:assert/strict";
import { boosterRolesWizard } from "./boosterRoles.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [],
  categories: [],
  roles: [
    { id: "1", name: "Booster I" },
    { id: "2", name: "Booster II" },
  ],
  emojis: [],
};

test("schema builds with $defs and strict objects", () => {
  const schema = boosterRolesWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
});

test("keeps several tiers, drops unknown roles, clamps days, keeps null stacking", () => {
  const config: Record<string, unknown> = {
    stacking: null,
    tiers: [
      { role_id: "1", duration_days: -3, name: null, enabled: null },
      { role_id: "404", duration_days: 30, name: "Ghost", enabled: true },
      { role_id: "2", duration_days: 99_999, name: " Veteran ", enabled: false },
    ],
  };
  assert.equal(boosterRolesWizard.validateConfig!(config, ctx), null);
  assert.equal(config.stacking, null);
  assert.deepEqual(config.tiers, [
    { role_id: "1", requirement: "duration", duration_days: 0, boost_count: null, name: null, enabled: null },
    { role_id: "2", requirement: "duration", duration_days: 3650, boost_count: null, name: "Veteran", enabled: false },
  ]);
});

test("boost-count tiers keep a clamped boost count and ignore days", () => {
  const config: Record<string, unknown> = {
    stacking: null,
    tiers: [
      { role_id: "1", requirement: "boosts", duration_days: 30, boost_count: 500, name: "Mega", enabled: null },
      { role_id: "2", requirement: "boosts", duration_days: 0, boost_count: null, name: null, enabled: null },
    ],
  };
  assert.equal(boosterRolesWizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config.tiers, [
    { role_id: "1", requirement: "boosts", duration_days: 0, boost_count: 100, name: "Mega", enabled: null },
    { role_id: "2", requirement: "boosts", duration_days: 0, boost_count: 2, name: null, enabled: null },
  ]);
});

test("a stacking-only change is fine, an empty result is not", () => {
  assert.equal(boosterRolesWizard.validateConfig!({ stacking: true, tiers: [] }, ctx), null);
  assert.match(
    boosterRolesWizard.validateConfig!({ stacking: null, tiers: [{ role_id: "9", duration_days: 1 }] }, ctx)!,
    /role/,
  );
});
