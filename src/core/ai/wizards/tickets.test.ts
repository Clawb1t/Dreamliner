import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketsWizard } from "./tickets.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100", name: "support" },
    { id: "101", name: "ticket-logs" },
  ],
  categories: [{ id: "400", name: "Tickets" }],
  roles: [{ id: "1", name: "Support" }],
  emojis: [{ id: "555555555555555555", name: "help", animated: false }],
};

/** Every object in a strict-mode schema must list all its keys as required and forbid extras. */
function assertStrict(node: unknown, path = "root"): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${path}[${i}]`));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === "object" || (Array.isArray(o.type) && o.type.includes("object"))) {
    assert.equal(o.additionalProperties, false, `${path} allows extra properties`);
    assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties as object).sort(), `${path} required`);
  }
  for (const [k, v] of Object.entries(o)) assertStrict(v, `${path}.${k}`);
}

function category(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: "General",
    description: null,
    emoji: null,
    button_style: null,
    category_channel_id: "400",
    mode: null,
    naming_pattern: null,
    welcome_message: null,
    support_role_ids: null,
    ping_role_ids: null,
    form_questions: null,
    max_open_per_user: null,
    auto_close_hours: null,
    escalation: null,
    close_permission: null,
    require_close_reason: null,
    transcript_channel_id: null,
    feedback_enabled: null,
    ...overrides,
  };
}

function base(overrides: Record<string, unknown> = {}, panel: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    staff_role_ids: null,
    log_channel_id: null,
    default_transcript_channel_id: null,
    dm_transcript_on_close: null,
    feedback_enabled: null,
    max_open_tickets_per_user: null,
    blacklist_notify: null,
    sync_status_to_topic: null,
    auto_status_updates: null,
    panel: {
      name: null,
      enabled: null,
      channel_id: "100",
      style: null,
      content: null,
      embed: null,
      categories: [category()],
      ...panel,
    },
    ...overrides,
  };
}

function question(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "Q",
    type: "text",
    style: null,
    required: null,
    placeholder: null,
    max_length: null,
    content: null,
    options: null,
    min_values: null,
    max_values: null,
    ...overrides,
  };
}

test("schema builds with $defs and strict objects everywhere", () => {
  const schema = ticketsWizard.buildResultSchema(ctx);
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  assertStrict(schema);
});

test("globals stay null so staff roles and log channels are never cleared", () => {
  const config = base();
  assert.equal(ticketsWizard.validateConfig!(config, ctx), null);
  for (const key of [
    "staff_role_ids",
    "log_channel_id",
    "default_transcript_channel_id",
    "max_open_tickets_per_user",
    "feedback_enabled",
  ]) {
    assert.equal(config[key], null, key);
  }
});

test("every category needs a real Discord category", () => {
  const config = base({}, { categories: [category({ category_channel_id: "" })] });
  assert.match(ticketsWizard.validateConfig!(config, ctx) ?? "", /category/);
  const noCategories = { ...ctx, categories: [] };
  assert.match(ticketsWizard.validateConfig!(base(), noCategories) ?? "", /category/);
});

test("more than 5 categories switches the panel to a select menu", () => {
  const cats = Array.from({ length: 7 }, (_, i) => category({ label: `C${i}` }));
  const config = base({}, { style: "buttons", categories: cats });
  assert.equal(ticketsWizard.validateConfig!(config, ctx), null);
  const panel = config.panel as Record<string, unknown>;
  assert.equal(panel.style, "select");
  assert.equal((panel.categories as unknown[]).length, 7);
});

test("sanitizes questions and escalation steps", () => {
  const config = base(
    {},
    {
      categories: [
        category({
          emoji: "help",
          form_questions: [
            question({ label: "What's wrong?", style: "paragraph", required: true, max_length: 99999 }),
            question({ label: "Pick one", type: "string_select", options: [] }),
            question({
              label: "Area",
              type: "radio_group",
              options: [{ label: "Billing", value: "", description: null }],
            }),
            question({ label: "Note", type: "text_display", content: "Please be patient." }),
            question({ label: "Files", type: "file_upload", min_values: 3, max_values: 1 }),
          ],
          escalation: [
            { after_minutes: 60, action: "notify_channel", role_id: "", channel_id: "101", priority: null, message: null },
            { after_minutes: 10, action: "ping_role", role_id: "1", channel_id: "", priority: null, message: "Ping!" },
            { after_minutes: 5, action: "ping_role", role_id: "", channel_id: "", priority: null, message: null },
            { after_minutes: 90, action: "set_priority", role_id: "", channel_id: "", priority: "urgent", message: null },
          ],
          transcript_channel_id: "999",
        }),
      ],
    },
  );
  assert.equal(ticketsWizard.validateConfig!(config, ctx), null);
  const cat = (config.panel as { categories: Record<string, unknown>[] }).categories[0]!;
  assert.equal(cat.emoji, "<:help:555555555555555555>");
  const questions = cat.form_questions as Record<string, unknown>[];
  assert.deepEqual(
    questions.map((q) => q.type),
    ["text", "radio_group", "text_display", "file_upload"],
  );
  assert.equal(questions[0]!.max_length, 4000);
  assert.deepEqual(questions[1]!.options, [{ label: "Billing", value: "Billing", description: null }]);
  assert.equal(questions[3]!.min_values, 1);
  const steps = cat.escalation as Record<string, unknown>[];
  assert.deepEqual(
    steps.map((s) => s.action),
    ["ping_role", "notify_channel", "set_priority"],
  );
  assert.equal(cat.transcript_channel_id, null);
});

test("prompt never uses em dashes", () => {
  assert.ok(!ticketsWizard.buildSystemPrompt(ctx, 0).includes(String.fromCharCode(0x2014)));
});
