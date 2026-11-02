import { test } from "node:test";
import assert from "node:assert/strict";
import { teamControlWizard, slugFor } from "./teamControl.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100", name: "staff-log" },
    { id: "101", name: "staff-chat" },
  ],
  categories: [],
  roles: [
    { id: "1", name: "Trial Mod" },
    { id: "2", name: "Moderator" },
    { id: "3", name: "Senior Mod" },
  ],
  emojis: [],
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ranks: null,
    manager_role_ids: null,
    log_channel_id: null,
    shifts: null,
    leave: null,
    actions: null,
    activity: null,
    roster: null,
    onboarding: null,
    ...overrides,
  };
}

test("schema builds with $defs and strict objects", () => {
  const schema = teamControlWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  assert.deepEqual([...(config.required as string[])].sort(), Object.keys(config.properties as object).sort());
});

test("ranks get unique slugs, clamped quotas and real roles", () => {
  const config = base({
    ranks: [
      { id: "Trial Mod!", name: "Trial Mod", role_id: "1", quota: { shift_hours: 2.55, mod_actions: 3.7, tickets: -1, messages: null, voice_hours: null } },
      { id: "", name: "Moderator", role_id: "2", quota: null },
      { id: "moderator", name: "Moderator again", role_id: "", quota: null },
    ],
    manager_role_ids: ["3", "999"],
  });
  assert.equal(teamControlWizard.validateConfig!(config, ctx), null);
  const ranks = config.ranks as Array<Record<string, unknown>>;
  assert.deepEqual(
    ranks.map((r) => r.id),
    ["trial_mod", "moderator", "moderator_2"],
  );
  assert.deepEqual(ranks[0]!.quota, { shift_hours: 2.6, mod_actions: 3, tickets: 0, messages: null, voice_hours: null });
  assert.deepEqual(config.manager_role_ids, ["3"]);
});

test("rejects invented ids and a role on two ranks", () => {
  assert.match(teamControlWizard.validateConfig!(base({ ranks: [{ id: "a", name: "A", role_id: "42", quota: null }] }), ctx) ?? "", /doesn't exist/);
  assert.match(
    teamControlWizard.validateConfig!(base({ ranks: [{ id: "a", name: "A", role_id: "1", quota: null }, { id: "b", name: "B", role_id: "1", quota: null }] }), ctx) ?? "",
    /two ranks/,
  );
  assert.match(teamControlWizard.validateConfig!(base({ roster: { enabled: true, channel_id: "555", title: null } }), ctx) ?? "", /doesn't exist/);
});

test("sections are normalized: thresholds, checklist, trial rank by name", () => {
  const config = base({
    ranks: [{ id: "trial", name: "Trial Mod", role_id: "1", quota: null }],
    actions: { enabled: true, log_channel_id: "100", announce_channel_id: "", suspended_role_id: null, dm_member: null, strike_expiry_days: 9999, strike_thresholds: [{ strikes: 50, action: "explode", suspend_days: 0 }] },
    activity: { enabled: true, period: "weekly", week_start: null, staff_channel_ids: ["101", "nope"], inactivity_days: 100, report_channel_id: null },
    onboarding: { enabled: true, checklist: [{ id: "", label: "Read the rules", description: "" }, { id: "x", label: "  ", description: "" }], trial_rank_id: "trial mod", trial_days: 200, review_channel_id: "100", dm_welcome: null },
  });
  assert.equal(teamControlWizard.validateConfig!(config, ctx), null);
  const actions = config.actions as Record<string, unknown>;
  assert.equal(actions.strike_expiry_days, 730);
  assert.deepEqual(actions.strike_thresholds, [{ strikes: 20, action: "notify", suspend_days: 1 }]);
  const activity = config.activity as Record<string, unknown>;
  assert.deepEqual(activity.staff_channel_ids, ["101"]);
  assert.equal(activity.inactivity_days, 60);
  const onboarding = config.onboarding as Record<string, unknown>;
  assert.deepEqual(onboarding.checklist, [{ id: "read_the_rules", label: "Read the rules", description: "" }]);
  assert.equal(onboarding.trial_rank_id, "trial");
  assert.equal(onboarding.trial_days, 90);
});

test("slugFor keeps valid slugs and dedupes", () => {
  const taken = new Set<string>();
  assert.equal(slugFor("rank_ab12cd", "x", taken), "rank_ab12cd");
  assert.equal(slugFor("rank_ab12cd", "x", taken), "rank_ab12cd_2");
  assert.equal(slugFor("!!!", "fallback", taken), "fallback");
});
