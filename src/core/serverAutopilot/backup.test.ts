import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backupCounts, backupStructureView, computeRestorePlan, parseBackupStructure, serializeBackup } from "./backup.js";
import { resolveMentions, starterDocument, buttonParts } from "./messages.js";
import { GUILD_ID, channel, role, snapshot } from "./testSupport.js";

function server() {
  const mods = role("Mods", { position: 5, permissions: "8192", color: 0xff0000 });
  const cat = channel("Chat", "category", { position: 0 });
  const general = channel("general", "text", {
    parentId: cat.id,
    position: 1,
    topic: "Talk here",
    slowmode: 5,
    overwrites: [
      { id: GUILD_ID, type: "role", allow: "0", deny: "2048" },
      { id: mods.id, type: "role", allow: "2048", deny: "0" },
      { id: "777777777777777777", type: "member", allow: "1024", deny: "0" },
    ],
  });
  const voice = channel("Lounge", "voice", { parentId: cat.id, position: 2, userLimit: 5, bitrate: 64000 });
  return { mods, cat, general, voice, snap: snapshot({ channels: [cat, general, voice], roles: [mods] }) };
}

describe("serializeBackup", () => {
  it("captures roles, channels and overwrites with role names", () => {
    const s = server();
    const backup = serializeBackup(s.snap, new Date("2026-11-08T12:00:00Z"));
    assert.equal(backup.version, 1);
    assert.equal(backup.takenAt, "2026-11-08T12:00:00.000Z");
    const general = backup.channels.find((c) => c.id === s.general.id)!;
    assert.equal(general.topic, "Talk here");
    assert.equal(general.slowmode, 5);
    assert.deepEqual(
      general.overwrites.map((o) => o.roleName),
      ["@everyone", "Mods", null],
    );
    assert.equal(backup.roles[0]!.position >= backup.roles[backup.roles.length - 1]!.position, true, "roles highest first");
    assert.ok(!("members" in backup.roles[0]!));
    assert.deepEqual(backupCounts(backup), { roles: 2, channels: 3 });
  });

  it("round-trips through JSON and rejects junk", () => {
    const s = server();
    const backup = serializeBackup(s.snap, new Date());
    assert.deepEqual(parseBackupStructure(JSON.stringify(backup)), backup);
    assert.equal(parseBackupStructure("{nope"), null);
    assert.equal(parseBackupStructure(JSON.stringify({ version: 2 })), null);
  });

  it("renders as the dashboard structure", () => {
    const s = server();
    const view = backupStructureView(serializeBackup(s.snap, new Date()), s.snap.bot);
    assert.equal(view.categories.length, 1);
    assert.deepEqual(view.categories[0]!.channels.map((c) => c.name), ["general", "Lounge"]);
    assert.ok(view.roles.some((r) => r.name === "Mods" && r.editable));
  });
});

describe("computeRestorePlan", () => {
  it("recreates deleted items and restores changed ones", () => {
    const s = server();
    const backup = serializeBackup(s.snap, new Date());
    const renamed = { ...s.general, name: "chat", topic: "", overwrites: [] };
    const added = channel("new-thing", "text");
    const addedRole = role("New Role", { position: 3 });
    const live = snapshot({ channels: [s.cat, renamed, added], roles: [addedRole] });
    const plan = computeRestorePlan(backup, live, false);
    assert.equal(plan.roles.find((r) => r.backupId === s.mods.id)!.action, "create");
    const general = plan.channels.find((c) => c.backupId === s.general.id)!;
    assert.equal(general.action, "update");
    assert.deepEqual(general.changes.sort(), ["name", "permissions", "topic"]);
    assert.equal(plan.channels.find((c) => c.backupId === s.voice.id)!.action, "create");
    assert.deepEqual(plan.deleteChannels, [], "nothing removed unless asked");
    assert.deepEqual(plan.deleteRoles, []);
  });

  it("removes what was added only when asked, never protected or managed things", () => {
    const s = server();
    const backup = serializeBackup(s.snap, new Date());
    const added = channel("new-thing", "text");
    const rules = channel("rules", "text");
    const addedRole = role("New Role", { position: 3 });
    const bot = role("Other Bot", { position: 3, managed: true });
    const live = snapshot({ channels: [...s.snap.channels, added, rules], roles: [s.mods, addedRole, bot], rulesChannelId: rules.id });
    const plan = computeRestorePlan(backup, live, true);
    assert.deepEqual(plan.deleteChannels.map((d) => d.id), [added.id]);
    assert.deepEqual(plan.deleteRoles.map((d) => d.id), [addedRole.id]);
  });

  it("skips roles above the bot and keeps bits the bot can't set", () => {
    const s = server();
    const backup = serializeBackup(s.snap, new Date());
    const raised = { ...s.mods, position: 50, name: "Renamed" };
    const live = snapshot({ channels: s.snap.channels, roles: [raised] });
    const plan = computeRestorePlan(backup, live, false);
    assert.equal(plan.roles.find((r) => r.backupId === s.mods.id)!.action, "skip");
    assert.ok(plan.warnings.length > 0);
  });
});

describe("starter messages", () => {
  it("resolves channel and role mentions", () => {
    const text = resolveMentions("See {#rules} and ask {@mod}. {#missing_one}", (k) => (k === "rules" ? "111111111111111111" : null), (k) => (k === "mod" ? "222222222222222222" : null));
    assert.equal(text, "See <#111111111111111111> and ask <@&222222222222222222>. #missing-one");
  });
  it("builds a valid kit with toggle buttons, five per row", () => {
    const roles = Array.from({ length: 7 }, (_, i) => ({ roleId: `${123456789012345000 + i}`, name: i === 0 ? "🎮 Gamer" : `Role ${i}` }));
    const doc = starterDocument({ key: "p", channel_key: "roles", kind: "role_picker", title: "Pick roles", body: "Pick!", color: 123, role_group: "Games" }, "Pick!", roles);
    assert.equal(doc.rows.length, 2);
    const first = doc.rows[0]!;
    assert.equal(first.type, "buttons");
    if (first.type === "buttons") {
      assert.equal(first.buttons.length, 5);
      assert.equal(first.buttons[0]!.label, "Gamer");
      assert.equal(first.buttons[0]!.emoji, "🎮");
      assert.deepEqual(first.buttons[0]!.action, { type: "role", mode: "toggle", role_ids: [roles[0]!.roleId], reply: "" });
    }
    assert.equal(doc.embeds[0]!.title, "Pick roles");
  });
  it("splits emoji off role names for buttons", () => {
    assert.deepEqual(buttonParts("Moderator 🛡️"), { label: "Moderator", emoji: "🛡️" });
    assert.deepEqual(buttonParts("Plain"), { label: "Plain", emoji: "" });
  });
});
