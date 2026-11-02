import { test } from "node:test";
import assert from "node:assert/strict";
import { roleRulesWizard } from "./roleRules.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [],
  categories: [],
  roles: [
    { id: "1", name: "Verified" },
    { id: "2", name: "Member" },
    { id: "3", name: "Unverified" },
    { id: "4", name: "Server Booster" },
  ],
  emojis: [],
};

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "",
    enabled: null,
    match: null,
    if_roles: null,
    unless_roles: null,
    give_roles: null,
    remove_roles: null,
    remove_matched: null,
    ...overrides,
  };
}

test("schema builds with $defs and strict objects", () => {
  const schema = roleRulesWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  const items = ((config.properties as Record<string, { items: Record<string, unknown> }>).rules).items;
  assert.equal(items.additionalProperties, false);
  assert.deepEqual([...(items.required as string[])].sort(), Object.keys(items.properties as object).sort());
});

test("keeps real roles only, caps lists and normalizes fields", () => {
  const config = {
    rules: [rule({ name: "  Verified to Member ", match: "nope", if_roles: ["1", "999"], give_roles: ["2", "2"], remove_roles: ["3"], remove_matched: "yes" })],
  };
  assert.equal(roleRulesWizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config.rules, [
    rule({ name: "Verified to Member", if_roles: ["1"], give_roles: ["2"], remove_roles: ["3"] }),
  ]);
});

test("same name twice: the later one wins; unnamed rules need if_roles", () => {
  const config = {
    rules: [
      rule({ name: "Boost", if_roles: ["4"], give_roles: ["2"] }),
      rule({ name: "boost", enabled: false }),
      rule({ name: "", if_roles: ["999"] }),
      rule({ name: "", if_roles: ["1"], give_roles: ["2"] }),
    ],
  };
  assert.equal(roleRulesWizard.validateConfig!(config, ctx), null);
  const rules = config.rules as Array<Record<string, unknown>>;
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], rule({ name: "boost", enabled: false }));
  assert.deepEqual(rules[1]!.if_roles, ["1"]);
});

test("rejects a result where every rule used invented roles", () => {
  assert.match(roleRulesWizard.validateConfig!({ rules: [rule({ if_roles: ["42"] })] }, ctx) ?? "", /real roles/);
  const empty = { rules: [] };
  assert.equal(roleRulesWizard.validateConfig!(empty, ctx), null);
});
