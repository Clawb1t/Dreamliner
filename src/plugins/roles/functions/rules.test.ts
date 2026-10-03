import { test } from "node:test";
import assert from "node:assert/strict";
import { zRoleRule, type RoleRule } from "../../../config/schemas/roleRules.js";
import { planRoleRules } from "./rules.js";

const A = "100000000000000001";
const B = "100000000000000002";
const C = "100000000000000003";
const D = "100000000000000004";
const X = "100000000000000009";

const rule = (partial: Partial<RoleRule>): RoleRule => zRoleRule.parse(partial);

test("Role A and Role B: take both away and give Role C", () => {
  const rules = [rule({ if_roles: [A, B], give_roles: [C], remove_matched: true })];
  assert.deepEqual(planRoleRules(rules, [A, B, X]), { status: "ok", add: [C], remove: [A, B], rules: ["Rule 1"] });
  // Only one of the two: "all" doesn't trigger.
  assert.deepEqual(planRoleRules(rules, [A]), { status: "ok", add: [], remove: [], rules: [] });
});

test("any, unless, and explicit removals", () => {
  const any = [rule({ match: "any", if_roles: [A, B], give_roles: [C], name: "Either" })];
  assert.deepEqual(planRoleRules(any, [B]), { status: "ok", add: [C], remove: [], rules: ["Either"] });
  const unless = [rule({ if_roles: [A], give_roles: [C], unless_roles: [X] })];
  assert.deepEqual(planRoleRules(unless, [A, X]), { status: "ok", add: [], remove: [], rules: [] });
  const removes = [rule({ if_roles: [A], remove_roles: [B, D] })];
  assert.deepEqual(planRoleRules(removes, [A, B]), { status: "ok", add: [], remove: [B], rules: ["Rule 1"] });
});

test("rules chain, and the result is stable (the bot's own change doesn't re-trigger)", () => {
  const rules = [
    rule({ if_roles: [A, B], give_roles: [C], remove_matched: true }),
    rule({ if_roles: [C], give_roles: [D] }),
  ];
  const plan = planRoleRules(rules, [A, B]);
  assert.deepEqual(plan, { status: "ok", add: [C, D], remove: [A, B], rules: ["Rule 1", "Rule 2"] });
  assert.deepEqual(planRoleRules(rules, [C, D]), { status: "ok", add: [], remove: [], rules: [] });
});

test("rules that undo each other are caught and nothing is applied", () => {
  const rules = [
    rule({ if_roles: [A], give_roles: [B], remove_matched: true, name: "A to B" }),
    rule({ if_roles: [B], give_roles: [A], remove_matched: true, name: "B to A" }),
  ];
  assert.equal(planRoleRules(rules, [A]).status, "loop");
});

test("disabled and empty rules do nothing", () => {
  const rules = [rule({ enabled: false, if_roles: [A], give_roles: [C] }), rule({ give_roles: [C] })];
  assert.deepEqual(planRoleRules(rules, [A]), { status: "ok", add: [], remove: [], rules: [] });
});
