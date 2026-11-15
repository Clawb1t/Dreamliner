import { test } from "node:test";
import assert from "node:assert/strict";
import type { GuildMember } from "discord.js";
import { zActivityRewardsConfig } from "../../../config/schemas/activityRewards.js";
import { hasReached, metricValue, requirementLabel } from "./config.js";
import { hasContributionMilestones, withContributions, type ContributionCounters } from "./contributions.js";
import { evaluateRoles } from "./rewards.js";

const config = zActivityRewardsConfig.parse({
  milestones: [
    { id: 1, metric: "messages", threshold: 10, roles: ["m"] },
    { id: 2, metric: "starboard_posts", threshold: 3, roles: ["star"] },
    { id: 3, metric: "suggestions_implemented", threshold: 1, roles: ["idea"] },
  ],
});

function counters(stars: number, ideas: number, calls: string[] = []): ContributionCounters {
  return {
    starboardPosts: (g, u) => {
      calls.push(`stars:${g}:${u}`);
      return stars;
    },
    suggestionsImplemented: (g, u) => {
      calls.push(`ideas:${g}:${u}`);
      return ideas;
    },
  };
}

test("contribution milestones parse and are detected", () => {
  assert.equal(hasContributionMilestones(config), true);
  assert.equal(hasContributionMilestones(zActivityRewardsConfig.parse({ milestones: [{ id: 1, threshold: 5 }] })), false);
});

test("withContributions counts only the metrics in use, and only once", () => {
  const calls: string[] = [];
  const onlyStars = zActivityRewardsConfig.parse({ milestones: [{ id: 1, metric: "starboard_posts", threshold: 1 }] });
  const filled = withContributions("g", "u", { messages: 0, voiceSeconds: 0 }, onlyStars, counters(4, 9, calls));
  assert.equal(filled.starboardPosts, 4);
  assert.equal(filled.suggestionsImplemented, undefined);
  assert.deepEqual(calls, ["stars:g:u"]);

  // Already filled: not counted again.
  withContributions("g", "u", filled, onlyStars, counters(4, 9, calls));
  assert.deepEqual(calls, ["stars:g:u"]);
});

test("no contribution milestones means no lookups", () => {
  const calls: string[] = [];
  const plain = zActivityRewardsConfig.parse({ milestones: [{ id: 1, threshold: 5 }] });
  withContributions("g", "u", { messages: 1, voiceSeconds: 0 }, plain, counters(1, 1, calls));
  assert.deepEqual(calls, []);
});

test("a failing counter leaves the track at zero instead of throwing", () => {
  const broken: ContributionCounters = {
    starboardPosts: () => {
      throw new Error("no such column");
    },
    suggestionsImplemented: () => 0,
  };
  const filled = withContributions("g", "u", { messages: 0, voiceSeconds: 0 }, config, broken);
  assert.equal(metricValue(filled, "starboard_posts"), 0);
});

test("contribution counts reach milestones and grant roles (backfill: existing counts count)", () => {
  const progress = withContributions("g", "u", { messages: 0, voiceSeconds: 0 }, config, counters(3, 1));
  const [, stars, ideas] = config.milestones;
  assert.equal(hasReached(progress, stars!), true);
  assert.equal(hasReached(progress, ideas!), true);
  const member = {
    roles: { cache: new Map() },
    guild: { roles: { cache: new Map([["m", {}], ["star", {}], ["idea", {}]]) } },
  } as unknown as GuildMember;
  assert.deepEqual(evaluateRoles(member, config, progress).toAdd.sort(), ["idea", "star"]);
  // One short of the starboard milestone.
  const fewer = withContributions("g", "u", { messages: 0, voiceSeconds: 0 }, config, counters(2, 0));
  assert.equal(hasReached(fewer, stars!), false);
});

test("requirement labels for contribution metrics", () => {
  assert.equal(requirementLabel({ metric: "starboard_posts", threshold: 1 }), "1 starboard post");
  assert.equal(requirementLabel({ metric: "starboard_posts", threshold: 5 }), "5 starboard posts");
  assert.equal(requirementLabel({ metric: "suggestions_implemented", threshold: 2 }), "2 implemented suggestions");
});
