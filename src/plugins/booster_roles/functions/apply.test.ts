import { test } from "node:test";
import assert from "node:assert/strict";
import type { GuildMember } from "discord.js";
import { MessageType } from "discord.js";
import { zBoosterRolesConfig, type BoosterRolesConfig } from "../../../config/schemas/boosterRoles.js";
import { evaluateBoosterRoles } from "./apply.js";
import { boostsInAnnouncement, isBoostAnnouncement } from "./boostCounts.js";
import { activeTiers } from "./config.js";

const DAY = 86_400_000;

function member(roleIds: string[]): GuildMember {
  const held = new Set(roleIds);
  return { roles: { cache: { has: (id: string) => held.has(id) } } } as unknown as GuildMember;
}

function config(tiers: unknown[], stacking = false): BoosterRolesConfig {
  return zBoosterRolesConfig.parse({ stacking, tiers });
}

const MIXED = config([
  { role_id: "d0", duration_days: 0 },
  { role_id: "d30", duration_days: 30 },
  { role_id: "b2", requirement: "boosts", boost_count: 2 },
  { role_id: "b5", requirement: "boosts", boost_count: 5 },
]);

test("old tiers without a requirement stay duration tiers", () => {
  const parsed = config([{ role_id: "r", duration_days: 7 }]);
  assert.equal(parsed.tiers[0]!.requirement, "duration");
});

test("tiers sort duration first, then boost count, each ascending", () => {
  assert.deepEqual(
    activeTiers(MIXED).map((t) => t.role_id),
    ["d0", "d30", "b2", "b5"],
  );
});

test("without stacking, the highest tier of each kind is kept", () => {
  const since = new Date(Date.now() - 40 * DAY);
  const result = evaluateBoosterRoles(member(["d0", "b2"]), since, MIXED, 6);
  assert.deepEqual(result.toAdd.sort(), ["b5", "d30"]);
  assert.deepEqual(result.toRemove.sort(), ["b2", "d0"]);
});

test("stacking keeps every qualified tier", () => {
  const since = new Date(Date.now() - 40 * DAY);
  const stacked = { ...MIXED, stacking: true };
  const result = evaluateBoosterRoles(member([]), since, stacked, 3);
  assert.deepEqual(result.toAdd.sort(), ["b2", "d0", "d30"]);
});

test("a single boost earns no boost-count tier; not boosting removes everything", () => {
  const since = new Date(Date.now() - 1 * DAY);
  assert.deepEqual(evaluateBoosterRoles(member([]), since, MIXED, 1).toAdd, ["d0"]);
  assert.deepEqual(evaluateBoosterRoles(member(["d30", "b5"]), null, MIXED).toRemove.sort(), ["b5", "d30"]);
});

test("boost announcements are recognised and counted from their content", () => {
  assert.ok(isBoostAnnouncement({ type: MessageType.GuildBoost }));
  assert.ok(isBoostAnnouncement({ type: MessageType.GuildBoostTier2 }));
  assert.ok(!isBoostAnnouncement({ type: MessageType.Default }));
  assert.equal(boostsInAnnouncement(""), 1);
  assert.equal(boostsInAnnouncement("3"), 3);
  assert.equal(boostsInAnnouncement("nonsense"), 1);
});
