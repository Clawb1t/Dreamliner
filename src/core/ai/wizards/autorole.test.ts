import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { autoroleWizard } from "./autorole.js";

const ctx: AiWizardContext = {
  guildName: "Test Server",
  voiceChannels: [],
  textChannels: [],
  categories: [],
  roles: [
    { id: "200000000000000001", name: "Member" },
    { id: "200000000000000002", name: "Bots" },
  ],
  emojis: [],
};

test("autorole schema uses role $defs and strict objects", () => {
  const schema = autoroleWizard.buildResultSchema(ctx);
  const defs = schema.$defs as Record<string, { enum?: string[] }>;
  assert.deepEqual(defs.role_id!.enum, ["200000000000000001", "200000000000000002"]);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  assert.deepEqual(config.required, ["roles", "bot_roles"]);
});

test("autorole validateConfig drops unknown roles, dedupes and clamps delays", () => {
  const config: Record<string, unknown> = {
    roles: [
      { role_id: "200000000000000001", delay_seconds: -5 },
      { role_id: "999", delay_seconds: 0 },
      { role_id: "200000000000000001", delay_seconds: 999999 },
    ],
    bot_roles: null,
  };
  assert.equal(autoroleWizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config.roles, [{ role_id: "200000000000000001", delay_seconds: 86400 }]);
  assert.equal(config.bot_roles, null);
});

test("autorole validateConfig errors when no real role is left", () => {
  const config: Record<string, unknown> = { roles: [{ role_id: "999", delay_seconds: 0 }], bot_roles: [] };
  assert.match(autoroleWizard.validateConfig!(config, ctx) ?? "", /real role/);
});
