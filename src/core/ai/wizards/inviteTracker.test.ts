import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteTrackerWizard } from "./inviteTracker.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100", name: "invite-log" },
    { id: "101", name: "welcome" },
  ],
  categories: [],
  roles: [
    { id: "1", name: "Moderator" },
    { id: "2", name: "Partner" },
  ],
  emojis: [],
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    log_channel_id: null,
    ignore_bots: null,
    count_on: null,
    passport: null,
    fake: null,
    join_message: null,
    leave_message: null,
    leaderboard: null,
    raid: null,
    retention_days: null,
    blacklist: null,
    ...overrides,
  };
}

test("schema builds with $defs and strict objects", () => {
  const schema = inviteTrackerWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  assert.deepEqual([...(config.required as string[])].sort(), Object.keys(config.properties as object).sort());
  assert.ok(!("links" in (config.properties as object)), "tracked links are live data, never config");
});

test("all-null result stays unchanged", () => {
  const config = base();
  assert.equal(inviteTrackerWizard.validateConfig!(config, ctx), null);
  assert.deepEqual(config, base());
});

test("numbers are clamped and enums checked", () => {
  const config = base({
    count_on: "verified",
    retention_days: 5,
    passport: { pending_timeout_hours: 9999 },
    fake: { min_account_age_days: 400, rejoin_policy: "nope", quick_leave_minutes: -3, quick_leave_as: "fake" },
    raid: { enabled: true, threshold_joins: 1, window_seconds: 9999, action: "pause_all", pause_minutes: 1, alert_role_id: "1" },
    blacklist: { role_ids: ["2", "999"] },
  });
  assert.equal(inviteTrackerWizard.validateConfig!(config, ctx), null);
  assert.equal(config.count_on, "verified");
  assert.equal(config.retention_days, 30);
  assert.deepEqual(config.passport, { pending_timeout_hours: 720 });
  assert.deepEqual(config.fake, { min_account_age_days: 365, rejoin_policy: null, quick_leave_minutes: 0, quick_leave_as: "fake" });
  assert.deepEqual(config.raid, { enabled: true, threshold_joins: 3, window_seconds: 600, action: "pause_all", pause_minutes: 15, alert_role_id: "1" });
  assert.deepEqual(config.blacklist, { role_ids: ["2"] });
});

test("messages keep rich content and need a real channel", () => {
  const config = base({
    join_message: { enabled: true, channel_id: "101", message: { content: "Hi {user}", embed: null, card: null }, unknown_message: null },
  });
  assert.equal(inviteTrackerWizard.validateConfig!(config, ctx), null);
  const join = config.join_message as Record<string, unknown>;
  assert.deepEqual(join.message, { content: "Hi {user}", embed: null, card: null });
  assert.equal(join.unknown_message, null);

  assert.match(inviteTrackerWizard.validateConfig!(base({ log_channel_id: "555" }), ctx) ?? "", /doesn't exist/);
  assert.match(
    inviteTrackerWizard.validateConfig!(base({ leave_message: { enabled: true, channel_id: "555", message: null } }), ctx) ?? "",
    /doesn't exist/,
  );
  assert.match(
    inviteTrackerWizard.validateConfig!(base({ leave_message: { enabled: true, channel_id: "", message: null } }), ctx) ?? "",
    /didn't pick a channel/,
  );
  assert.match(
    inviteTrackerWizard.validateConfig!(base({ raid: { enabled: true, threshold_joins: null, window_seconds: null, action: null, pause_minutes: null, alert_role_id: "42" } }), ctx) ?? "",
    /doesn't exist/,
  );
});
