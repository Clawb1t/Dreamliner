import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { memberIdentityWizard } from "./memberIdentity.js";

const ctx: AiWizardContext = {
  guildName: "Test Server",
  voiceChannels: [],
  textChannels: [],
  categories: [],
  roles: [{ id: "200000000000000001", name: "Muted" }],
  emojis: [],
};

test("member identity schema has role $defs and is strict", () => {
  const schema = memberIdentityWizard.buildResultSchema(ctx);
  assert.ok((schema.$defs as Record<string, unknown>).role_id);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  assert.ok((config.required as string[]).includes("ignored_roles"));
  assert.ok((config.required as string[]).includes("save_on_update"));
});

test("member identity validateConfig keeps nulls, filters roles, clamps delay", () => {
  const config: Record<string, unknown> = {
    save_on_leave: null,
    save_on_update: true,
    restore_nickname: "yes",
    restore_roles: false,
    restore_timeout: null,
    skip_managed_roles: null,
    ignore_bots: null,
    ignored_roles: ["200000000000000001", "404"],
    delay_seconds: 900,
  };
  assert.equal(memberIdentityWizard.validateConfig!(config, ctx), null);
  assert.equal(config.save_on_leave, null);
  assert.equal(config.save_on_update, true);
  assert.equal(config.restore_nickname, null);
  assert.deepEqual(config.ignored_roles, ["200000000000000001"]);
  assert.equal(config.delay_seconds, 300);
});
