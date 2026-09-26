import { test } from "node:test";
import assert from "node:assert/strict";
import { automodWizard, normalizeDomain, validateAutomodConfig } from "./automod.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [
    { id: "100", name: "general" },
    { id: "101", name: "mod-log" },
  ],
  categories: [],
  roles: [
    { id: "200", name: "Mods" },
    { id: "201", name: "Admins" },
  ],
  emojis: [],
};

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node)) walk(value, visit);
}

test("schema builds with id $defs and every object is strict", () => {
  const schema = automodWizard.buildResultSchema(ctx);
  const defs = schema.$defs as Record<string, { enum?: string[] }>;
  assert.deepEqual(defs.text_channel_id?.enum, ["100", "101"]);
  assert.deepEqual(defs.role_id?.enum, ["200", "201"]);
  let objects = 0;
  walk(schema, (n) => {
    if (n.type === "object" && n.properties) {
      objects++;
      assert.equal(n.additionalProperties, false);
      assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties as object).sort());
    }
  });
  assert.ok(objects > 5);
  assert.ok(!JSON.stringify(schema).includes("\u2014"));
});

test("prompt lists every capability without em dashes", () => {
  const prompt = automodWizard.buildSystemPrompt(ctx, 0);
  assert.ok(!prompt.includes("\u2014"));
  for (const word of ["ignored_channels", "ignored_roles", "custom_filter", "blocked_domains", "ladder", "general", "Mods"]) {
    assert.match(prompt, new RegExp(word));
  }
  assert.doesNotMatch(prompt, /not supported/i);
});

test("validateConfig sanitizes ids, bounds, regex, and drops unknown rules", () => {
  const config: Record<string, unknown> = {
    preset: "bogus",
    categories: ["spam", "nope", "spam"],
    ignored_channels: ["100", "999"],
    ignored_roles: ["200", "x"],
    log_channel_id: "999",
    dm_users: null,
    native: { enabled: true, alert_channel_id: "101", spam_detection: null, timeout_seconds: 99_999_999 },
    escalation_bridge: { feed_real_escalation: true, use_infraction_history: null, points_per_infraction: 50, lookback_ms: -5 },
    rules: [
      { rule_id: "not_a_rule", enabled: true },
      {
        rule_id: "custom_filter",
        enabled: true,
        sensitivity: null,
        strike_window_ms: 5,
        delete_message: null,
        points: 500,
        notify: null,
        case_reason: "x".repeat(600),
        log_silent_hits_as_cases: null,
        ignored_channels: ["100", "nope"],
        ignored_roles: null,
        ladder: [
          { after: 3, actions: [{ type: "mute", duration_ms: 99 * 86_400_000, reason: null, notify: null, delete_message_days: 30, points: null }] },
          { after: 0, actions: [{ type: "delete", duration_ms: null, reason: "", notify: true, delete_message_days: null, points: 500 }] },
          { after: 5, actions: [{ type: "explode" }] },
        ],
        settings: {
          entries: [
            { pattern: " badword ", regex: false, enabled: true },
            { pattern: "BADWORD", regex: false, enabled: true },
            { pattern: "(unclosed", regex: true, enabled: true },
            { pattern: "fr[e3]e\\s*nitro", regex: true, enabled: true },
            { pattern: "   ", regex: false, enabled: true },
          ],
          blocked_domains: ["https://bit.ly/abc"],
          max_links: 3,
          list_mode: "replace",
        },
      },
      {
        rule_id: "excessive_caps",
        enabled: null,
        sensitivity: null,
        settings: { max_percent: 10, min_length: 500, count: 5, entries: null },
      },
      { rule_id: "excessive_caps", enabled: true, sensitivity: null, settings: null },
      {
        rule_id: "links",
        settings: { blocked_domains: ["*.Example.COM", "not a domain", "www.tinyurl.com/x", "example.com"], max_links: 100 },
      },
    ],
  };
  assert.equal(validateAutomodConfig(config, ctx), null);

  assert.equal(config.preset, null);
  assert.deepEqual(config.categories, ["spam"]);
  assert.deepEqual(config.ignored_channels, ["100"]);
  assert.deepEqual(config.ignored_roles, ["200"]);
  assert.equal(config.log_channel_id, null);
  assert.deepEqual(config.native, { enabled: true, alert_channel_id: "101", spam_detection: null, timeout_seconds: 2_419_200 });
  assert.deepEqual(config.escalation_bridge, {
    feed_real_escalation: true,
    use_infraction_history: null,
    points_per_infraction: 20,
    lookback_ms: 0,
  });

  const rules = config.rules as Record<string, unknown>[];
  assert.deepEqual(rules.map((r) => r.rule_id), ["custom_filter", "excessive_caps", "links"]);

  const cf = rules[0]!;
  assert.equal(cf.strike_window_ms, 1000);
  assert.equal(cf.points, 100);
  assert.equal((cf.case_reason as string).length, 400);
  assert.deepEqual(cf.ignored_channels, ["100"]);
  assert.equal(cf.ignored_roles, null);
  assert.equal(cf.sensitivity, null, "no numeric settings for custom_filter, so sensitivity stays unchanged");
  const ladder = cf.ladder as { after: number; actions: Record<string, unknown>[] }[];
  assert.deepEqual(ladder.map((s) => s.after), [1, 3]);
  assert.equal(ladder[1]!.actions[0]!.duration_ms, 28 * 86_400_000);
  assert.equal(ladder[1]!.actions[0]!.delete_message_days, 7);
  assert.equal(ladder[0]!.actions[0]!.points, 100);
  assert.equal(ladder[0]!.actions[0]!.reason, null);
  const cfSettings = cf.settings as Record<string, unknown>;
  assert.deepEqual(cfSettings.entries, [
    { pattern: "badword", regex: false, enabled: true },
    { pattern: "fr[e3]e\\s*nitro", regex: true, enabled: true },
  ]);
  assert.equal(cfSettings.blocked_domains, null, "blocked_domains belongs to links, not custom_filter");
  assert.equal(cfSettings.max_links, null);
  assert.equal(cfSettings.list_mode, "replace");

  const caps = rules[1]!;
  assert.equal(caps.enabled, true, "duplicate overrides merge");
  assert.equal(caps.sensitivity, "custom", "explicit thresholds switch sensitivity to custom");
  const capsSettings = caps.settings as Record<string, unknown>;
  assert.equal(capsSettings.max_percent, 40);
  assert.equal(capsSettings.min_length, 100);
  assert.equal(capsSettings.count, null);

  const links = rules[2]!.settings as Record<string, unknown>;
  assert.deepEqual(links.blocked_domains, ["example.com", "tinyurl.com"]);
  assert.equal(links.max_links, 20);
  assert.equal(rules[2]!.enabled, null);
});

test("all-null result stays all-null", () => {
  const config: Record<string, unknown> = {
    preset: null,
    categories: null,
    ignored_channels: null,
    ignored_roles: null,
    log_channel_id: null,
    dm_users: null,
    native: null,
    escalation_bridge: null,
    rules: null,
  };
  assert.equal(validateAutomodConfig(config, ctx), null);
  for (const value of Object.values(config)) assert.equal(value, null);
});

test("log channel accepts empty string for none", () => {
  const config: Record<string, unknown> = { log_channel_id: "", rules: [] };
  validateAutomodConfig(config, ctx);
  assert.equal(config.log_channel_id, "");
  assert.deepEqual(config.rules, []);
});

test("ladder steps with the same threshold merge, and an unusable ladder means unchanged", () => {
  const act = (type: string) => ({ type, duration_ms: null, reason: null, notify: null, delete_message_days: null, points: null });
  const config: Record<string, unknown> = {
    rules: [
      { rule_id: "spam", ladder: [{ after: 1, actions: [act("delete")] }, { after: 1, actions: [act("warn")] }] },
      { rule_id: "invites", ladder: [{ after: 1, actions: [] }] },
    ],
  };
  validateAutomodConfig(config, ctx);
  const [spam, invites] = config.rules as Record<string, unknown>[];
  assert.deepEqual(
    (spam!.ladder as { after: number; actions: { type: string }[] }[]).map((s) => [s.after, s.actions.map((a) => a.type)]),
    [[1, ["delete", "warn"]]],
  );
  assert.equal(invites!.ladder, null);
});

test("normalizeDomain", () => {
  assert.equal(normalizeDomain("HTTPS://www.Discord-Nitro.gift/claim?x=1"), "discord-nitro.gift");
  assert.equal(normalizeDomain("bit.ly"), "bit.ly");
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeDomain(42), null);
});
