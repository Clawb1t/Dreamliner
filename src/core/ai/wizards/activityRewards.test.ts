import { test } from "node:test";
import assert from "node:assert/strict";
import { activityRewardsWizard } from "./activityRewards.js";
import type { AiWizardContext } from "../wizardKit.js";
import { zActivityRewardsConfig } from "../../../config/schemas/activityRewards.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [{ id: "300", name: "Lounge" }],
  textChannels: [{ id: "100", name: "level-ups" }],
  categories: [{ id: "400", name: "Staff" }],
  roles: [
    { id: "1", name: "Regular" },
    { id: "2", name: "Veteran" },
  ],
  emojis: [],
};

function milestone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metric: "messages",
    threshold: 100,
    name: null,
    enabled: null,
    roles: ["1"],
    remove_roles: null,
    announce: null,
    channel_id: null,
    message_mode: null,
    message: null,
    ...overrides,
  };
}

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestones: [milestone()],
    stacking: null,
    announcement: null,
    message_cooldown_seconds: null,
    min_message_length: null,
    ignored_channels: null,
    ignored_roles: null,
    voice_require_others: null,
    voice_ignore_muted: null,
    voice_ignore_afk: null,
    ...overrides,
  };
}

test("schema builds with $defs and strict objects", () => {
  const schema = activityRewardsWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  assert.equal(schema.additionalProperties, false);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  assert.deepEqual(
    [...(config.required as string[])].sort(),
    Object.keys(config.properties as object).sort(),
  );
});

test("normalizes milestones: drops unknown roles, later duplicate wins, clamps", () => {
  const config = base({
    milestones: [
      milestone({ name: "Regular", roles: ["1", "999", "1"] }),
      milestone({ name: "dup", roles: ["2"], remove_roles: ["404"] }),
      milestone({ metric: "voice_minutes", threshold: -5, roles: [] }),
    ],
    message_cooldown_seconds: 99_999,
    min_message_length: -3,
    ignored_channels: ["100", "300", "400", "nope"],
    ignored_roles: ["2", "x"],
  });
  assert.equal(activityRewardsWizard.validateConfig!(config, ctx), null);
  const milestones = config.milestones as Record<string, unknown>[];
  assert.equal(milestones.length, 2);
  assert.equal(milestones[0]!.name, "dup");
  assert.deepEqual(milestones[0]!.roles, ["2"]);
  assert.deepEqual(milestones[0]!.remove_roles, []);
  assert.equal(milestones[1]!.threshold, 1);
  assert.equal(config.message_cooldown_seconds, 3600);
  assert.equal(config.min_message_length, 0);
  assert.deepEqual(config.ignored_channels, ["100", "300", "400"]);
  assert.deepEqual(config.ignored_roles, ["2"]);
});

test("null settings stay null, empty milestone list is allowed", () => {
  const config = base({ milestones: [], stacking: false });
  assert.equal(activityRewardsWizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config.milestones, []);
  assert.equal(config.ignored_channels, null);
  assert.equal(config.message_cooldown_seconds, null);
});

test("caps milestones at 50", () => {
  const config = base({ milestones: Array.from({ length: 60 }, (_, i) => milestone({ threshold: i + 1 })) });
  assert.equal(activityRewardsWizard.validateConfig!(config, ctx), null);
  assert.equal((config.milestones as unknown[]).length, 50);
});

test("rejects unknown announcement channels and a fixed destination with no channel", () => {
  const announcement = (a: Record<string, unknown>) => ({
    enabled: null,
    destination: null,
    channel_id: null,
    content: null,
    embed: null,
    card: null,
    ...a,
  });
  assert.match(
    activityRewardsWizard.validateConfig!(base({ announcement: announcement({ channel_id: "404" }) }), ctx)!,
    /channel/,
  );
  assert.match(
    activityRewardsWizard.validateConfig!(
      base({ announcement: announcement({ destination: "channel", channel_id: "" }) }),
      ctx,
    )!,
    /channel/,
  );
  assert.equal(
    activityRewardsWizard.validateConfig!(
      base({ announcement: announcement({ enabled: false, destination: "channel", channel_id: "" }) }),
      ctx,
    ),
    null,
  );
  // null channel keeps the current one, so a fixed destination is fine.
  assert.equal(
    activityRewardsWizard.validateConfig!(base({ announcement: announcement({ destination: "channel" }) }), ctx),
    null,
  );
});

test("validated milestones fit the real config schema once defaults and ids are filled", () => {
  const config = base();
  activityRewardsWizard.validateConfig!(config, ctx);
  const milestones = (config.milestones as Record<string, unknown>[]).map((m, i) => ({
    id: i + 1,
    name: m.name ?? "",
    metric: m.metric,
    threshold: m.threshold,
    roles: m.roles ?? [],
  }));
  assert.equal(zActivityRewardsConfig.safeParse({ milestones }).success, true);
});

test("prompt lists every placeholder and never uses em dashes", () => {
  const prompt = activityRewardsWizard.buildSystemPrompt(ctx, 0);
  for (const p of ["{milestone}", "{milestone_requirement}", "{messages}", "{voice_time}", "{voice_hours}", "{reward_roles}", "{next_milestone}", "{member_count}"]) {
    assert.ok(prompt.includes(p), p);
  }
  assert.ok(!prompt.includes(String.fromCharCode(0x2014)));
});
