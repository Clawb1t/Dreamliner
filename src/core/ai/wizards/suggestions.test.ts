import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestionsConfigSchema, suggestionsWizard } from "./suggestions.js";
import type { AiWizardContext } from "../wizardKit.js";
import { zSuggestionsConfig } from "../../../config/schemas/suggestions.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100", name: "suggestions" },
    { id: "101", name: "staff-review" },
  ],
  categories: [],
  roles: [{ id: "1", name: "Staff" }],
  emojis: [{ id: "777777", name: "upboat", animated: true }],
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys((suggestionsConfigSchema() as { properties: object }).properties)) config[key] = null;
  return { ...config, ...overrides };
}

test("schema builds with $defs and strict objects and covers every non-permission setting", () => {
  const schema = suggestionsWizard.buildResultSchema(ctx) as Record<string, unknown>;
  assert.ok(schema.$defs);
  const config = (schema.properties as Record<string, { anyOf: Record<string, unknown>[] }>).config.anyOf[1]!;
  assert.equal(config.additionalProperties, false);
  const covered = new Set(Object.keys(config.properties as object));
  const missing = Object.keys(zSuggestionsConfig.shape).filter((k) => !k.startsWith("can_") && !covered.has(k));
  assert.deepEqual(missing, []);
});

test("sanitizes durations, ids, emojis and bounds", () => {
  const config = base({
    suggestions_channel_id: "100",
    cooldown: " 2H ",
    min_account_age: "a week",
    min_member_age: "",
    allowed_vote_roles: ["1", "404"],
    review_ping_role: "404",
    upvote_emoji: "upboat",
    downvote_emoji: "\u{1F44E}",
    upvote_label: "  ",
    max_length: 50,
    min_length: 80,
    color_change_color: 0x1ffffff,
  });
  assert.equal(suggestionsWizard.validateConfig!(config, ctx), null);
  assert.equal(config.cooldown, "2h");
  assert.equal(config.min_account_age, null);
  assert.equal(config.min_member_age, "");
  assert.deepEqual(config.allowed_vote_roles, ["1"]);
  assert.equal(config.review_ping_role, null);
  assert.equal(config.upvote_emoji, "<a:upboat:777777>");
  assert.equal(config.downvote_emoji, "\u{1F44E}");
  assert.equal(config.upvote_label, null);
  assert.equal(config.min_length, 50);
  assert.equal(config.color_change_color, 0xffffff);
  assert.equal(config.mode, null);
});

test("rejects unknown feed/review channels and review mode with the review channel cleared", () => {
  assert.match(suggestionsWizard.validateConfig!(base({ suggestions_channel_id: "404" }), ctx)!, /suggestions channel/);
  assert.match(suggestionsWizard.validateConfig!(base({ review_channel_id: "404" }), ctx)!, /review channel/);
  assert.match(suggestionsWizard.validateConfig!(base({ mode: "review", review_channel_id: "" }), ctx)!, /review/);
  assert.equal(suggestionsWizard.validateConfig!(base({ mode: "review" }), ctx), null);
});
