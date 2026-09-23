import { test } from "node:test";
import assert from "node:assert/strict";
import type { GuildMember } from "discord.js";
import { zActivityRewardsConfig } from "../../../config/schemas/activityRewards.js";
import { hasReached, milestoneLabel, requirementLabel } from "./config.js";
import { evaluateRoles, resolveAnnouncementTarget } from "./rewards.js";

function fakeMember(held: string[], guildRoles: string[] = ["a", "b", "c", "v1", "v2", "starter"]): GuildMember {
  return {
    roles: { cache: new Map(held.map((id) => [id, {}])) },
    guild: { roles: { cache: new Map(guildRoles.map((id) => [id, {}])) } },
  } as unknown as GuildMember;
}

const ladder = (stacking: boolean) =>
  zActivityRewardsConfig.parse({
    stacking,
    milestones: [
      { id: 1, metric: "messages", threshold: 10, roles: ["a"], remove_roles: ["starter"] },
      { id: 2, metric: "messages", threshold: 100, roles: ["b"] },
      { id: 3, metric: "messages", threshold: 1000, roles: ["c"] },
      { id: 4, metric: "voice_minutes", threshold: 60, roles: ["v1"] },
      { id: 5, metric: "voice_minutes", threshold: 600, roles: ["v2"], enabled: false },
    ],
  });

test("stacking keeps every reached role and removes starter roles", () => {
  const diff = evaluateRoles(fakeMember(["starter"]), ladder(true), { messages: 150, voiceSeconds: 3600 });
  assert.deepEqual(diff.toAdd.sort(), ["a", "b", "v1"]);
  assert.deepEqual(diff.toRemove, ["starter"]);
});

test("non-stacking keeps only the highest role per track", () => {
  const diff = evaluateRoles(fakeMember(["a", "v1"]), ladder(false), { messages: 150, voiceSeconds: 3600 });
  assert.deepEqual(diff.toAdd, ["b"]);
  assert.deepEqual(diff.toRemove, ["a"]);
});

test("disabled milestones and roles missing from the guild are ignored", () => {
  const diff = evaluateRoles(fakeMember([], ["a"]), ladder(true), { messages: 5000, voiceSeconds: 99_999 });
  assert.deepEqual(diff.toAdd, ["a"]);
});

test("voice thresholds are minutes", () => {
  const [, , , voice] = ladder(true).milestones;
  assert.equal(hasReached({ messages: 0, voiceSeconds: 3599 }, voice!), false);
  assert.equal(hasReached({ messages: 0, voiceSeconds: 3600 }, voice!), true);
  assert.equal(requirementLabel(voice!), "1 hour in voice");
  assert.equal(milestoneLabel(ladder(true).milestones[2]!), "1,000 messages");
});

test("announcement target: milestone override, then destination, then fallback channel", () => {
  const config = zActivityRewardsConfig.parse({
    announcement: { destination: "current", channel_id: "fallback" },
    milestones: [
      { id: 1, threshold: 1 },
      { id: 2, threshold: 2, channel_id: "override" },
    ],
  });
  const [plain, overridden] = config.milestones;
  assert.deepEqual(resolveAnnouncementTarget(config, overridden!, "here"), { kind: "channel", channelId: "override" });
  assert.deepEqual(resolveAnnouncementTarget(config, plain!, "here"), { kind: "channel", channelId: "here" });
  assert.deepEqual(resolveAnnouncementTarget(config, plain!, null), { kind: "channel", channelId: "fallback" });
});
