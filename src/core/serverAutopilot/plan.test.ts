import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { computePlan } from "./plan.js";
import { BOT_ID, GUILD_ID, ch, channel, role, snapshot, tRole, template } from "./testSupport.js";

const noKeep = { channelIds: [], roleIds: [] };

describe("computePlan: empty server", () => {
  it("creates everything in add mode, deletes nothing", () => {
    const { plan, resolved } = computePlan({ template: template(), mode: "add", keep: noKeep, snap: snapshot() });
    assert.equal(plan.counts.create, 3 + 3 + 7);
    assert.equal(plan.counts.update, 0);
    assert.equal(plan.counts.delete, 0);
    assert.equal(plan.requiresConfirm, false);
    assert.deepEqual(plan.blockers, []);
    assert.equal(resolved.categories.length, 3);
    assert.ok(plan.ops.some((o) => o.op === "reorder"));
    const firstCreate = plan.ops.findIndex((o) => o.op === "create_category");
    const lastRole = plan.ops.map((o) => o.op).lastIndexOf("create_role");
    assert.ok(lastRole < firstCreate, "roles come before channels");
  });

  it("formats names with the template naming", () => {
    const t = template({ naming: { ...template().naming, channel_pattern: "{emoji}｜{name}", emoji_mode: "all" } });
    t.categories[1]!.channels[0]!.emoji = "💬";
    const { resolved } = computePlan({ template: t, mode: "add", keep: noKeep, snap: snapshot() });
    assert.equal(resolved.channels.find((c) => c.key === "general")!.name, "💬｜general");
    assert.equal(resolved.categories.find((c) => c.key === "community")!.name, "COMMUNITY");
  });

  it("syncs everyone-access channels with their category and hides staff areas", () => {
    const { resolved } = computePlan({ template: template(), mode: "add", keep: noKeep, snap: snapshot() });
    const general = resolved.channels.find((c) => c.key === "general")!;
    assert.equal(general.syncWithParent, true);
    const staff = resolved.categories.find((c) => c.key === "staff")!;
    const everyone = staff.overwrites.find((o) => o.target.kind === "everyone")!;
    assert.equal(BigInt(everyone.deny) & PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ViewChannel);
    assert.ok(staff.overwrites.some((o) => o.target.kind === "bot"), "the bot keeps access to hidden categories");
    assert.ok(staff.overwrites.some((o) => o.target.kind === "role" && o.target.key === "mod"));
    const rules = resolved.channels.find((c) => c.key === "rules")!;
    assert.equal(rules.syncWithParent, false);
    assert.equal(BigInt(rules.overwrites.find((o) => o.target.kind === "everyone")!.deny) & PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessages);
  });
});

describe("computePlan: blockers and limits", () => {
  it("blocks without Manage Channels / Manage Roles", () => {
    const snap = snapshot({ bot: { userId: BOT_ID, roleId: null, highestPosition: 1, permissions: "0", administrator: false } });
    const { plan } = computePlan({ template: template(), mode: "add", keep: noKeep, snap });
    assert.equal(plan.blockers.length, 2);
  });

  it("blocks when the guild would pass 500 channels", () => {
    const channels = Array.from({ length: 495 }, (_, i) => channel(`c${i}`, "text"));
    const { plan } = computePlan({ template: template(), mode: "add", keep: noKeep, snap: snapshot({ channels }) });
    assert.ok(plan.blockers.some((b) => b.includes("500")));
  });

  it("drops permissions the bot lacks and warns", () => {
    const t = template({ roles: [tRole("admin", "Admin", "admin")] });
    const { plan, resolved } = computePlan({ template: t, mode: "add", keep: noKeep, snap: snapshot() });
    const perms = BigInt(resolved.roles[0]!.permissions);
    assert.equal(perms & PermissionFlagsBits.BanMembers, 0n);
    assert.equal(perms & PermissionFlagsBits.KickMembers, PermissionFlagsBits.KickMembers);
    assert.equal(perms & PermissionFlagsBits.Administrator, 0n);
    assert.ok(plan.warnings.some((w) => w.includes("Admin")));
  });

  it("converts community-only channel types on non-community servers", () => {
    const t = template();
    t.categories[0]!.channels[1]!.type = "announcement";
    t.categories[1]!.channels.push(ch("stage", "town hall", { type: "stage", purpose: "stage" }));
    const { plan, resolved } = computePlan({ template: t, mode: "add", keep: noKeep, snap: snapshot({ community: false }) });
    assert.equal(resolved.channels.find((c) => c.key === "announcements")!.type, "text");
    assert.equal(resolved.channels.find((c) => c.key === "stage")!.type, "voice");
    assert.ok(plan.warnings.some((w) => w.includes("Community")));
  });
});

describe("computePlan: merge", () => {
  function existingServer() {
    const cat = channel("Text Channels", "category");
    const general = channel("general", "text", { parentId: cat.id, hasMessages: true });
    const rules = channel("📜︱server-rules", "text", { parentId: cat.id });
    const random = channel("random", "text", { parentId: cat.id, hasMessages: true });
    const voice = channel("General", "voice");
    const mods = role("Mods", { position: 5 });
    const high = role("Head Admin", { position: 20 });
    const fans = role("Fans", { position: 2 });
    return { cat, general, rules, random, voice, mods, high, fans };
  }

  it("reuses channels by purpose and name, renames and moves them, keeps messages", () => {
    const e = existingServer();
    const snap = snapshot({ channels: [e.cat, e.general, e.rules, e.random, e.voice], roles: [e.mods, e.high, e.fans] });
    const { plan, resolved } = computePlan({ template: template(), mode: "merge", keep: noKeep, snap });
    const rules = resolved.channels.find((c) => c.key === "rules")!;
    assert.equal(rules.channelId, e.rules.id, "📜︱server-rules matched by purpose");
    assert.equal(rules.action, "update");
    assert.ok(rules.changes.includes("name") && rules.changes.includes("move"));
    assert.equal(resolved.channels.find((c) => c.key === "general")!.channelId, e.general.id);
    assert.equal(resolved.channels.find((c) => c.key === "lounge")!.channelId, e.voice.id, "voice General matches the lounge");
    assert.equal(plan.counts.delete, 0, "merge deletes nothing");
    const mod = resolved.roles.find((r) => r.key === "mod")!;
    assert.equal(mod.roleId, e.mods.id, "Mods ↔ moderator preset");
    assert.equal(mod.action, "update");
    assert.ok(mod.changes.includes("name"));
  });

  it("never edits roles above the bot (reuses them as they are)", () => {
    const high = role("Admin", { position: 20 });
    const snap = snapshot({ roles: [high] });
    const { plan, resolved } = computePlan({ template: template(), mode: "merge", keep: noKeep, snap });
    const admin = resolved.roles.find((r) => r.key === "admin")!;
    assert.equal(admin.roleId, high.id);
    assert.equal(admin.action, "reuse");
    assert.ok(plan.warnings.some((w) => w.includes("above Dreamliner")));
  });

  it("only adds permissions to matched roles, never removes", () => {
    const mods = role("Moderator", { position: 5, permissions: (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageMessages).toString() });
    const { resolved } = computePlan({ template: template(), mode: "merge", keep: noKeep, snap: snapshot({ roles: [mods] }) });
    const perms = BigInt(resolved.roles.find((r) => r.key === "mod")!.permissions);
    assert.equal(perms & PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageGuild);
    assert.equal(perms & PermissionFlagsBits.KickMembers, PermissionFlagsBits.KickMembers);
  });

  it("add mode reuses matches without changing them", () => {
    const e = existingServer();
    const snap = snapshot({ channels: [e.cat, e.general, e.rules], roles: [e.mods] });
    const { plan, resolved } = computePlan({ template: template(), mode: "add", keep: noKeep, snap });
    assert.equal(resolved.channels.find((c) => c.key === "general")!.action, "reuse");
    assert.equal(resolved.roles.find((r) => r.key === "mod")!.action, "reuse");
    assert.equal(plan.counts.update, 0);
  });

  it("keeps protected and keep-list channels exactly as they are", () => {
    const e = existingServer();
    const snap = snapshot({ channels: [e.cat, e.general, e.rules], rulesChannelId: e.rules.id });
    const { resolved } = computePlan({ template: template(), mode: "merge", keep: { channelIds: [e.general.id], roleIds: [] }, snap });
    assert.equal(resolved.channels.find((c) => c.key === "rules")!.action, "reuse");
    assert.equal(resolved.channels.find((c) => c.key === "general")!.action, "reuse");
  });

  it("prefers ids from an interrupted run", () => {
    const made = channel("memes-old", "text");
    const { resolved } = computePlan({ template: template(), mode: "merge", keep: noKeep, snap: snapshot({ channels: [made] }), idMap: { roles: {}, channels: { memes: made.id } } });
    assert.equal(resolved.channels.find((c) => c.key === "memes")!.channelId, made.id);
  });
});

describe("computePlan: fresh", () => {
  it("deletes unmatched channels and roles, but never protected, kept, managed, booster or higher ones", () => {
    const cat = channel("Old", "category");
    const old = channel("old-chat", "text", { parentId: cat.id, hasMessages: true });
    const rulesCh = channel("rules", "text");
    const system = channel("join-log", "text");
    const logs = channel("bot-logs", "text");
    const kept = channel("archive", "text");
    const oldRole = role("Old Role", { position: 3 });
    const keptRole = role("Keep Me", { position: 3 });
    const managed = role("Some Bot", { managed: true, position: 4 });
    const booster = role("Server Booster", { isBooster: true, position: 4 });
    const above = role("Owner", { position: 30 });
    const snap = snapshot({
      channels: [cat, old, rulesCh, system, logs, kept],
      roles: [oldRole, keptRole, managed, booster, above],
      rulesChannelId: rulesCh.id,
      systemChannelId: system.id,
      logChannelIds: [logs.id],
    });
    const { plan, resolved } = computePlan({ template: template(), mode: "fresh", keep: { channelIds: [kept.id], roleIds: [keptRole.id] }, snap });
    const deletedChannels = resolved.deleteChannels.map((d) => d.id).sort();
    assert.deepEqual(deletedChannels, [cat.id, old.id].sort());
    assert.deepEqual(resolved.deleteRoles.map((d) => d.id), [oldRole.id]);
    assert.equal(plan.requiresConfirm, true);
    const del = plan.ops.find((o) => o.op === "delete_channel" && o.channelId === old.id);
    assert.ok(del && del.op === "delete_channel" && del.messageWarning);
    const ops = plan.ops.map((o) => o.op);
    assert.ok(ops.indexOf("delete_channel") > ops.lastIndexOf("create_channel"), "deletes come after creates");
    assert.ok(ops.indexOf("delete_channel") < ops.indexOf("delete_role"));
  });

  it("a logs plugin frees the old log channel for deletion", () => {
    const logs = channel("bot-logs", "text");
    const t = template({ plugins: [{ plugin: "logs", channel_key: "mod_logs", role_key: null, extra_role_keys: [], level: "standard" }] });
    const { resolved } = computePlan({ template: t, mode: "fresh", keep: noKeep, snap: snapshot({ channels: [logs], logChannelIds: [logs.id] }) });
    assert.ok(resolved.deleteChannels.some((d) => d.id === logs.id));
  });

  it("is deterministic", () => {
    const snap = snapshot({ channels: [channel("general", "text"), channel("memes", "text")], roles: [role("Mod", { position: 2 })] });
    const a = computePlan({ template: template(), mode: "fresh", keep: noKeep, snap });
    const b = computePlan({ template: template(), mode: "fresh", keep: noKeep, snap });
    assert.deepEqual(a, b);
  });
});

describe("computePlan: permissions on existing channels", () => {
  it("reports permissions only when managed overwrites differ", () => {
    const general = channel("general", "text", {
      overwrites: [{ id: "999999999999999999", type: "member", allow: "1024", deny: "0" }],
    });
    const t = template({ categories: [], uncategorized: [ch("general", "general", { purpose: "general" })], roles: [] });
    const { resolved } = computePlan({ template: t, mode: "merge", keep: noKeep, snap: snapshot({ channels: [general] }) });
    assert.equal(resolved.channels[0]!.action, "reuse", "a member overwrite Autopilot doesn't manage is ignored");
    const locked = channel("general", "text", { overwrites: [{ id: GUILD_ID, type: "role", allow: "0", deny: "2048" }] });
    const second = computePlan({ template: t, mode: "merge", keep: noKeep, snap: snapshot({ channels: [locked] }) });
    assert.deepEqual(second.resolved.channels[0]!.changes, ["permissions"]);
  });
});
