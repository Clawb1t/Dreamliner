import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAnswers } from "./answers.js";
import { cleanEmoji, normalizeTemplate, parseTemplateInput, sanitizeTemplate, slugKey } from "./template.js";
import { ch, tRole, template } from "./testSupport.js";
import { SA_LIMITS } from "./types.js";

describe("parseAnswers", () => {
  it("fills every default from nothing", () => {
    const a = parseAnswers(undefined);
    assert.equal(a.basics.language, "English");
    assert.equal(a.audience.size, "small");
    assert.equal(a.existing.mode, "merge");
    assert.equal(a.naming.channel_pattern, "{name}");
    assert.equal(a.naming.preset, "clean");
  });
  it("drops unknown values instead of failing", () => {
    const a = parseAnswers({ basics: { type: "nope", server_name: 42 }, features: ["rules", "bogus"], naming: { channel_pattern: "no token", font: "bold" }, existing: { keep_channel_ids: ["123", "123456789012345678"] } });
    assert.equal(a.basics.type, "community");
    assert.equal(a.basics.server_name, "");
    assert.deepEqual(a.features, ["rules"]);
    assert.equal(a.naming.channel_pattern, "{name}");
    assert.equal(a.naming.font, "bold");
    assert.deepEqual(a.existing.keep_channel_ids, ["123456789012345678"]);
  });
});

describe("sanitizeTemplate", () => {
  it("turns junk into a template-shaped object", () => {
    const t = sanitizeTemplate({ name: 5, roles: [{ preset: "god", extra_permissions: ["Administrator"] }], categories: [{ channels: [{ type: "weird", slowmode: 99999999, user_limit: -4 }] }], plugins: [{ plugin: "nope" }] });
    assert.equal(t.name, "");
    assert.equal(t.roles[0]!.preset, "cosmetic");
    assert.equal(t.categories[0]!.channels[0]!.type, "text");
    assert.equal(t.categories[0]!.channels[0]!.slowmode, SA_LIMITS.slowmodeMax);
    assert.equal(t.categories[0]!.channels[0]!.user_limit, 0);
  });
  it("survives non-objects", () => {
    const t = sanitizeTemplate("hello");
    assert.deepEqual(t.categories, []);
  });
});

describe("cleanEmoji / slugKey", () => {
  it("keeps real emoji only", () => {
    assert.equal(cleanEmoji("💬"), "💬");
    assert.equal(cleanEmoji("🛡️"), "🛡️");
    assert.equal(cleanEmoji("<:custom:123456789012345678>"), "");
    assert.equal(cleanEmoji("chat"), "");
    assert.equal(cleanEmoji("💬🎮🎧"), "💬");
  });
  it("slugifies keys", () => {
    assert.equal(slugKey("General Chat!"), "general_chat");
    assert.equal(slugKey("--Ünïcode--"), "unicode");
  });
});

describe("parseTemplateInput", () => {
  it("accepts a valid template", () => {
    const result = parseTemplateInput(template());
    assert.ok(result.ok);
  });
  it("reports precise issues", () => {
    const bad = template();
    bad.categories[1]!.channels[0]!.base = "";
    bad.categories[1]!.channels[1]!.topic = "x".repeat(2000);
    const result = parseTemplateInput(bad);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok(result.issues.some((i) => i.path === "categories[1].channels[0].base"));
      assert.ok(result.issues.some((i) => i.path === "categories[1].channels[1].topic"));
    }
  });
  it("rejects more than 60 channels in total", () => {
    const t = template({ categories: [], uncategorized: Array.from({ length: 61 }, (_, i) => ch(`c${i}`, `c ${i}`)) });
    assert.ok(!parseTemplateInput(t).ok);
  });
});

describe("normalizeTemplate", () => {
  it("dedupes keys and role names and drops dangling references", () => {
    const t = template({
      roles: [tRole("mod", "Moderator", "moderator"), tRole("mod", "Helper", "helper"), tRole("x", "moderator", "member")],
      plugins: [{ plugin: "starboard", channel_key: "missing", role_key: "ghost", extra_role_keys: ["ghost"], level: "standard" }],
    });
    t.categories[1]!.channels.push(ch("general", "general two", { role_keys: ["ghost"], access: "roles" }));
    const { template: out } = normalizeTemplate(t);
    assert.deepEqual(out.roles.map((r) => r.key), ["mod", "mod_2"]);
    const keys = out.categories.flatMap((c) => c.channels.map((x) => x.key));
    assert.equal(new Set(keys).size, keys.length);
    const dup = out.categories[1]!.channels.find((x) => x.base === "general two")!;
    assert.deepEqual(dup.role_keys, []);
    assert.equal(dup.access, "read_only", "roles access without roles becomes read-only");
    assert.deepEqual(out.plugins, [], "starboard without a starboard channel is skipped");
  });

  it("clamps limits", () => {
    const many = template({
      roles: Array.from({ length: 40 }, (_, i) => tRole(`r${i}`, `Role ${i}`, "cosmetic")),
      categories: Array.from({ length: 20 }, (_, i) => ({ key: `cat${i}`, base: `cat ${i}`, emoji: "", access: "everyone" as const, role_keys: [], channels: Array.from({ length: 5 }, (_, j) => ch(`c${i}_${j}`, `chan ${i} ${j}`)) })),
    });
    const { template: out } = normalizeTemplate(many);
    assert.equal(out.roles.length, SA_LIMITS.roles);
    assert.equal(out.categories.length, SA_LIMITS.categories);
    assert.ok(out.categories.reduce((n, c) => n + c.channels.length, 0) <= SA_LIMITS.channels);
  });

  it("never lets staff and log channels be public, and strips staff permissions from member roles", () => {
    const t = template({ roles: [tRole("member", "Member", "member", { extra_permissions: ["BanMembers", "AttachFiles", "Administrator"] }), tRole("mod", "Mod", "moderator", { self_assignable: true, group: "x" })] });
    t.categories[2]!.access = "everyone";
    const { template: out } = normalizeTemplate(t);
    assert.ok(out.categories[2]!.channels.every((c) => c.access === "staff_only"));
    assert.deepEqual(out.roles[0]!.extra_permissions, ["AttachFiles"]);
    assert.equal(out.roles[1]!.self_assignable, false, "staff roles are never self-assignable");
  });

  it("applies walkthrough guarantees", () => {
    const answers = parseAnswers({
      features: ["rules", "logs", "staff_area"],
      roles: { staff: ["moderator"] },
      moderation: { verification: "reaction_role", read_only_info: true, nsfw_allowed: false },
      plugins: { wanted: ["welcome_message", "logs"], auto: false },
      messages: { wanted: ["rules"] },
      naming: { preset: "emoji_bar", channel_pattern: "{emoji}｜{name}", emoji_mode: "all" },
    });
    const t = template({
      naming: { ...template().naming, channel_pattern: "{name}" },
      roles: [tRole("mod", "Moderator", "moderator"), tRole("member", "Member", "member")],
      categories: [
        { key: "info", base: "info", emoji: "", access: "everyone", role_keys: [], channels: [ch("rules", "rules", { purpose: "rules" }), ch("welcome", "welcome", { purpose: "welcome" })] },
        { key: "chat", base: "chat", emoji: "", access: "everyone", role_keys: [], channels: [ch("general", "general", { purpose: "general", nsfw: true })] },
      ],
      plugins: [{ plugin: "starboard", channel_key: null, role_key: null, extra_role_keys: [], level: "standard" }],
      messages: [
        { key: "rules", channel_key: "rules", kind: "rules", title: "", body: "Be nice.", color: null, role_group: "" },
        { key: "faq", channel_key: "rules", kind: "faq", title: "FAQ", body: "Q?", color: null, role_group: "" },
      ],
    });
    const { template: out } = normalizeTemplate(t, answers);
    const flat = [...out.uncategorized, ...out.categories.flatMap((c) => c.channels)];
    assert.equal(out.naming.channel_pattern, "{emoji}｜{name}", "the manager's naming wins");
    const staffCat = out.categories.find((c) => c.channels.some((x) => x.purpose === "staff_chat"))!;
    assert.equal(staffCat.access, "staff_only", "the staff chat lives in a hidden category");
    assert.ok(flat.some((c) => c.purpose === "mod_logs"));
    assert.ok(flat.some((c) => c.purpose === "verify"));
    assert.ok(out.roles.some((r) => r.preset === "verified" && r.self_assignable && r.group === "Verification"));
    assert.equal(flat.find((c) => c.key === "rules")!.access, "read_only");
    assert.equal(flat.find((c) => c.key === "general")!.nsfw, false);
    assert.equal(out.categories.find((c) => c.key === "chat")!.access, "verified_only", "verification gates non-info categories");
    assert.equal(out.categories.find((c) => c.key === "info")!.access, "everyone");
    assert.deepEqual(out.plugins.map((p) => p.plugin).sort(), ["logs", "welcome_message"], "only wanted plugins; missing wanted ones are added");
    assert.equal(out.plugins.find((p) => p.plugin === "welcome_message")!.channel_key, "welcome");
    assert.deepEqual(out.messages.map((m) => m.kind).sort(), ["role_picker", "rules"], "unwanted kinds dropped, verify picker kept");
    assert.equal(out.messages.find((m) => m.kind === "rules")!.title, "Server rules");
  });

  it("is idempotent", () => {
    const answers = parseAnswers({ features: ["logs", "staff_area"], moderation: { verification: "passport" }, plugins: { wanted: ["passport", "logs"] } });
    const once = normalizeTemplate(template(), answers).template;
    const twice = normalizeTemplate(once, answers).template;
    assert.deepEqual(twice, once);
  });

  it("drops role pickers without self roles and fixes their group", () => {
    const t = template({
      roles: [tRole("he", "he/him", "cosmetic", { self_assignable: true, group: "Pronouns" })],
      messages: [
        { key: "p", channel_key: "general", kind: "role_picker", title: "Pronouns", body: "Pick one", color: null, role_group: "Nope" },
        { key: "p2", channel_key: "general", kind: "role_picker", title: "Again", body: "Pick", color: null, role_group: "Pronouns" },
      ],
    });
    const { template: out } = normalizeTemplate(t);
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0]!.role_group, "Pronouns");
  });
});
