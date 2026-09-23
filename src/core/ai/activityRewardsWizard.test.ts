import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_WIZARDS, type AiWizardContext } from "./wizards.js";
import { zActivityRewardsConfig } from "../../config/schemas/activityRewards.js";

const wizard = AI_WIZARDS.activity_rewards_setup!;
const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100", name: "level-ups" }],
  categories: [],
  roles: [
    { id: "1", name: "Regular" },
    { id: "2", name: "Veteran" },
  ],
  emojis: [],
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stacking: true,
    milestones: [{ name: "", metric: "messages", threshold: 100, roles: ["1"] }],
    announce: true,
    destination: "current",
    channel_id: "100",
    content: "🎉 {user} reached {milestone}!",
    message_cooldown_seconds: 30,
    voice_require_others: true,
    voice_ignore_muted: true,
    ...overrides,
  };
}

test("normalizes milestones: drops unknown roles, dedupes, clamps", () => {
  const config = base({
    milestones: [
      { name: "Regular", metric: "messages", threshold: 100, roles: ["1", "999", "1"] },
      { name: "dup", metric: "messages", threshold: 100, roles: ["2"] },
      { name: "", metric: "voice_minutes", threshold: -5, roles: [] },
    ],
    message_cooldown_seconds: 99_999,
  });
  assert.equal(wizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config.milestones, [
    { name: "Regular", metric: "messages", threshold: 100, roles: ["1"] },
    { name: "", metric: "voice_minutes", threshold: 1, roles: [] },
  ]);
  assert.equal(config.message_cooldown_seconds, 3600);
});

test("rejects empty ladders, unknown channels, and a fixed destination with no channel", () => {
  assert.match(wizard.validateConfig!(base({ milestones: [] }), ctx)!, /milestones/);
  assert.match(wizard.validateConfig!(base({ channel_id: "404" }), ctx)!, /channel/);
  assert.match(wizard.validateConfig!(base({ destination: "channel", channel_id: "" }), ctx)!, /channel/);
  assert.equal(wizard.validateConfig!(base({ announce: false, destination: "channel", channel_id: "" }), ctx), null);
});

test("validated milestones fit the real config schema once the dashboard adds ids", () => {
  const config = base();
  wizard.validateConfig!(config, ctx);
  const milestones = (config.milestones as Record<string, unknown>[]).map((m, i) => ({ ...m, id: i + 1 }));
  assert.equal(zActivityRewardsConfig.safeParse({ milestones }).success, true);
});
