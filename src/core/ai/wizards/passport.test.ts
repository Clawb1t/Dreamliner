import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiWizardContext } from "../wizardKit.js";
import { passportWizard } from "./passport.js";

const ctx: AiWizardContext = {
  guildName: "Test Server",
  voiceChannels: [],
  textChannels: [{ id: "100000000000000001", name: "verify" }],
  categories: [],
  roles: [
    { id: "200000000000000001", name: "Unverified" },
    { id: "200000000000000002", name: "Member" },
  ],
  emojis: [{ id: "300000000000000001", name: "check", animated: true }],
};

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node)) walk(value, visit);
}

test("passport schema has $defs and every object is strict", () => {
  const schema = passportWizard.buildResultSchema(ctx);
  const defs = schema.$defs as Record<string, unknown>;
  assert.ok(defs.role_id && defs.text_channel_id && defs.welcome_embed);
  walk(schema, (n) => {
    if (n.type === "object") {
      assert.equal(n.additionalProperties, false);
      assert.deepEqual(n.required, Object.keys(n.properties as object));
    }
  });
  assert.ok(!passportWizard.buildSystemPrompt(ctx, 0).includes(String.fromCharCode(0x2014)));
});

test("passport validateConfig clamps, resolves emoji and keeps unknowns unchanged", () => {
  const config: Record<string, unknown> = {
    channel_id: "404",
    unverified_role_id: "200000000000000001",
    grant_role_ids: ["404"],
    remove_role_ids: [],
    strip_roles_until_verified: null,
    nickname: "x".repeat(40),
    bypass_role_ids: ["200000000000000002", "200000000000000002"],
    remember_verifications: null,
    alt_detection: true,
    min_account_age_seconds: 999_999_999,
    timeout_action: "kick",
    timeout_seconds: -1,
    timeout_dm: null,
    deescalation: { enabled: true, factor: 4 },
    ping: {
      enabled: true,
      ping_style: "loud",
      content: null,
      embed: { enabled: true, color: -3, fields: null },
      button_label: "",
      button_emoji: "check",
      also_dm: null,
      delete_on_verify: null,
      delete_on_leave: null,
      delete_after_seconds: 10_000_000,
    },
    panel: null,
    page: { headline: "Hi {guild}", verify_button_label: "", background: "asset", accent_color: 70000000 },
  };
  assert.equal(passportWizard.validateConfig!(config, ctx), null);
  assert.equal(config.channel_id, null);
  assert.equal(config.unverified_role_id, "200000000000000001");
  assert.equal(config.grant_role_ids, null, "an all-invalid grant list keeps the current roles");
  assert.deepEqual(config.remove_role_ids, []);
  assert.deepEqual(config.bypass_role_ids, ["200000000000000002"]);
  assert.equal((config.nickname as string).length, 32);
  assert.equal(config.min_account_age_seconds, 31_536_000);
  assert.equal(config.timeout_seconds, 0);
  assert.deepEqual(config.deescalation, { enabled: true, factor: 1 });
  const ping = config.ping as Record<string, unknown>;
  assert.equal(ping.ping_style, null);
  assert.equal(ping.button_label, null);
  assert.equal(ping.button_emoji, "<a:check:300000000000000001>");
  assert.equal(ping.delete_after_seconds, 604_800);
  assert.equal((ping.embed as Record<string, unknown>).color, 0);
  const page = config.page as Record<string, unknown>;
  assert.equal(page.headline, "Hi {guild}");
  assert.equal(page.verify_button_label, null);
  assert.equal(page.background, null, "uploaded asset backgrounds are dashboard-only");
  assert.equal(page.accent_color, 0xffffff);
  assert.equal(page.body, null);
});
