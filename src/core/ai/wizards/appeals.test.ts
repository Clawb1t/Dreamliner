import { test } from "node:test";
import assert from "node:assert/strict";
import { zAppealsConfig } from "../../../config/schemas/appeals.js";
import type { AiWizardContext } from "../wizardKit.js";
import { appealsConfigSchema, appealsWizard } from "./appeals.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100", name: "appeals-review" },
    { id: "101", name: "welcome" },
  ],
  categories: [],
  roles: [
    { id: "1", name: "Moderator" },
    { id: "2", name: "Muted" },
  ],
  emojis: [],
};

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node)) walk(value, visit);
}

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of Object.keys((appealsConfigSchema() as { properties: object }).properties)) config[key] = null;
  return { ...config, ...overrides };
}

test("schema is strict, has $defs and covers every non-permission setting", () => {
  const schema = appealsWizard.buildResultSchema(ctx);
  assert.ok(schema.$defs);
  walk(schema, (n) => {
    if (n.type === "object") {
      assert.equal(n.additionalProperties, false);
      assert.deepEqual(n.required, Object.keys(n.properties as object));
    }
  });
  const covered = new Set(Object.keys((appealsConfigSchema() as { properties: object }).properties));
  const missing = Object.keys(zAppealsConfig.shape).filter((k) => !k.startsWith("can_") && !covered.has(k));
  assert.deepEqual(missing, []);
  assert.ok(!appealsWizard.buildSystemPrompt(ctx, 0).includes(String.fromCharCode(0x2014)));
});

test("rejects a made-up review channel", () => {
  const config = base({ review: { channel_id: "404", ping_roles: null, thread: null, require_deny_reason: null, show_history: null } });
  assert.match(appealsWizard.validateConfig!(config, ctx)!, /review channel/);
});

test("sanitizes forms, form indexes, durations, limits and the page", () => {
  const config = base({
    review: { channel_id: "100", ping_roles: ["1", "404"], thread: true, require_deny_reason: null, show_history: null },
    forms: [
      {
        name: "Ban appeal",
        intro: null,
        questions: [
          { label: "Why should we unban you?", type: "text", style: null, required: true, placeholder: null, min_length: 900, max_length: 500, content: null, options: null, min_values: null, max_values: null },
          { label: "Pick one", type: "radio_group", style: null, required: true, placeholder: null, min_length: null, max_length: null, content: null, options: [{ label: "A", value: "", description: null }, { label: "A", value: "", description: null }], min_values: null, max_values: null },
          { label: "", type: "text_display", style: null, required: null, placeholder: null, min_length: null, max_length: null, content: "**Read the rules**", options: null, min_values: null, max_values: null },
          { label: "Empty select", type: "string_select", style: null, required: true, placeholder: null, min_length: null, max_length: null, content: null, options: [], min_values: null, max_values: null },
        ],
      },
      { name: "Only text", intro: null, questions: [{ label: "", type: "text_display", style: null, required: null, placeholder: null, min_length: null, max_length: null, content: "hi", options: null, min_values: null, max_values: null }] },
    ],
    types: {
      ban: { enabled: true, form_index: 0, min_wait: "1 Day", window: " 90D ", allow_inactive: null, auto_reverse: true },
      tempban: null,
      softban: null,
      kick: { enabled: true, form_index: 5, min_wait: "", window: "24H", allow_inactive: null, auto_reverse: null },
      mute: null,
      tempmute: null,
      warn: null,
    },
    limits: { max_per_case: 50, deny_cooldown: "2w", max_open_per_user: 0, min_account_age: "soon", blocked_roles: ["2", "404"] },
    page: { headline: "  ", body: "Hi {guild}", background: "url", background_url: "http://insecure.example/x.png", accent_color: 99999999 },
    decisions: { dm_user: null, approve_message: "", deny_message: "Denied.", needs_info_message: null, invite_on_unban: true, invite_channel_id: "404" },
    dm_button: { enabled: true, label: "  " },
  });
  assert.equal(appealsWizard.validateConfig!(config, ctx), null);

  const review = config.review as Record<string, unknown>;
  assert.deepEqual(review.ping_roles, ["1"]);

  const forms = config.forms as { questions: Record<string, unknown>[] }[];
  assert.equal(forms.length, 1, "a form with no answerable question is dropped");
  const [text, radio, display] = forms[0]!.questions;
  assert.equal(forms[0]!.questions.length, 3, "a select with no options is dropped");
  assert.equal(text!.min_length, 500, "min_length never exceeds max_length");
  assert.equal(text!.style, "paragraph");
  assert.deepEqual(radio!.options, [{ label: "A", value: "A", description: null }]);
  assert.equal(display!.content, "**Read the rules**");

  const types = config.types as Record<string, Record<string, unknown> | null>;
  assert.equal(types.ban!.form_index, 0);
  assert.equal(types.ban!.min_wait, null, "\"1 Day\" is not a duration Dreamliner reads");
  assert.equal(types.ban!.window, "90d");
  assert.equal(types.kick!.form_index, null, "out-of-range form index is unchanged");
  assert.equal(types.kick!.min_wait, "");
  assert.equal(types.kick!.window, "24h");

  const limits = config.limits as Record<string, unknown>;
  assert.equal(limits.max_per_case, 10);
  assert.equal(limits.max_open_per_user, 1);
  assert.equal(limits.deny_cooldown, "2w");
  assert.equal(limits.min_account_age, null);
  assert.deepEqual(limits.blocked_roles, ["2"]);

  const page = config.page as Record<string, unknown>;
  assert.equal(page.headline, null, "blank headline keeps the current one");
  assert.equal(page.background_url, null, "only https images");
  assert.equal(page.background, null, "url background without a usable url is unchanged");
  assert.equal(page.accent_color, 0xffffff);

  const decisions = config.decisions as Record<string, unknown>;
  assert.equal(decisions.approve_message, null);
  assert.equal(decisions.invite_channel_id, null);
  assert.equal((config.dm_button as Record<string, unknown>).label, null);
});

test("form indexes are ignored when no forms are returned", () => {
  const config = base({
    types: { ban: { enabled: true, form_index: 0, min_wait: null, window: null, allow_inactive: null, auto_reverse: null }, tempban: null, softban: null, kick: null, mute: null, tempmute: null, warn: null },
  });
  assert.equal(appealsWizard.validateConfig!(config, ctx), null);
  assert.equal((config.types as Record<string, Record<string, unknown>>).ban!.form_index, null);
});
