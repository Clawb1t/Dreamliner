import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import type { ActorInfo } from "../actorPermissions.js";
import { computeRestorePlan, serializeBackup } from "./backup.js";
import { FRESH_NEEDS_ADMIN, computePlan } from "./plan.js";
import { GUILD_ID, channel, role, snapshot, template } from "./testSupport.js";

const P = PermissionFlagsBits;
const noKeep = { channelIds: [], roleIds: [] };

function actor(patch: Partial<ActorInfo> = {}): ActorInfo {
  return { userId: "600000000000000001", owner: false, administrator: false, superuser: false, permissions: P.ManageGuild, highestPosition: 8, ...patch };
}

/** A staff member who could build this themselves: channels, roles, and the permissions they hand out. */
const builder = actor({
  permissions: P.ManageGuild | P.ManageChannels | P.ManageRoles | P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.Connect | P.Speak | P.AddReactions | P.AttachFiles | P.EmbedLinks,
  highestPosition: 8,
});

describe("computePlan with an actor", () => {
  it("refuses a Manage Server-only member, naming the permissions they need", () => {
    const { plan } = computePlan({ template: template(), mode: "add", keep: noKeep, snap: snapshot(), actor: actor() });
    assert.deepEqual(plan.missingPermissions, ["Manage Channels", "Manage Roles"]);
    assert.ok(plan.blockers.some((b) => b.startsWith("You need Manage Roles to build roles. Ask someone with that permission, or remove the roles")));
    assert.ok(plan.blockers.some((b) => b.startsWith("You need Manage Channels")));
    assert.ok(plan.permissions!.every((p) => !p.met));
  });

  it("allows a member with Manage Channels + Manage Roles, trimming role permissions to theirs", () => {
    const { plan, resolved } = computePlan({ template: template(), mode: "add", keep: noKeep, snap: snapshot(), actor: builder });
    assert.deepEqual(plan.missingPermissions, []);
    assert.deepEqual(plan.blockers, []);
    for (const r of resolved.roles) {
      assert.equal(BigInt(r.permissions) & ~builder.permissions, 0n, `@${r.name} gets nothing the builder lacks`);
    }
    for (const c of [...resolved.categories, ...resolved.channels]) {
      for (const o of c.overwrites) assert.equal((BigInt(o.allow) | BigInt(o.deny)) & ~builder.permissions, 0n, `${c.name} overwrites stay within the builder's permissions`);
    }
    assert.ok(plan.warnings.some((w) => /you don't have (that permission|those permissions) yourself/.test(w)), "the moderator preset's moderation perms are trimmed with a warning");
  });

  it("never edits or deletes roles at or above the member's highest role", () => {
    const above = role("Moderator", { position: 9, permissions: "0" });
    const below = role("Member", { position: 3, permissions: "0" });
    const stray = role("Old staff", { position: 9 });
    const strayLow = role("Old", { position: 2 });
    // The bot sits above everything here (position 10); the member at 8.
    const snap = snapshot({ roles: [above, below, stray, strayLow] });
    const { resolved, plan } = computePlan({ template: template(), mode: "merge", keep: noKeep, snap, actor: builder });
    const mod = resolved.roles.find((r) => r.key === "mod")!;
    assert.equal(mod.roleId, above.id);
    assert.equal(mod.action, "reuse");
    assert.ok(plan.warnings.some((w) => w.includes("@Moderator is at or above your highest role")));

    const fresh = computePlan({ template: template(), mode: "fresh", keep: noKeep, snap, actor: { ...builder, administrator: true } });
    const deleted = fresh.resolved.deleteRoles.map((d) => d.id);
    assert.ok(deleted.includes(strayLow.id));
    assert.ok(!deleted.includes(stray.id), "a role above the member isn't removed, even by an administrator");
  });

  it("fresh builds need Administrator or the owner", () => {
    const { plan } = computePlan({ template: template(), mode: "fresh", keep: noKeep, snap: snapshot(), actor: builder });
    assert.ok(plan.blockers.includes(FRESH_NEEDS_ADMIN));
    assert.ok(plan.missingPermissions!.includes("Administrator"));
    const owner = computePlan({ template: template(), mode: "fresh", keep: noKeep, snap: snapshot(), actor: actor({ owner: true, permissions: 0n, highestPosition: 0 }) });
    assert.deepEqual(owner.plan.blockers, []);
  });

  it("without an actor the plan is unchanged (bot-only limits)", () => {
    const { plan } = computePlan({ template: template(), mode: "add", keep: noKeep, snap: snapshot() });
    assert.deepEqual(plan.permissions, []);
    assert.deepEqual(plan.blockers, []);
  });
});

describe("computeRestorePlan with an actor", () => {
  function server() {
    const admin = role("Admin", { position: 9, permissions: P.Administrator.toString() });
    const vip = role("VIP", { position: 2, permissions: P.SendMessages.toString() });
    const general = channel("general", "text", { overwrites: [{ id: GUILD_ID, type: "role", allow: "0", deny: P.SendMessages.toString() }] });
    const snap = snapshot({ roles: [admin, vip], channels: [general] });
    return { admin, vip, general, snap, backup: serializeBackup(snap, new Date()) };
  }

  it("refuses a Manage Server-only member", () => {
    const s = server();
    // Something to restore: VIP and the channel were renamed since.
    const live = { ...s.snap, roles: s.snap.roles.map((r) => (r.id === s.vip.id ? { ...r, name: "Renamed" } : r)), channels: s.snap.channels.map((c) => ({ ...c, name: "chat" })) };
    const plan = computeRestorePlan(s.backup, live, false, actor());
    assert.ok(plan.blockers.some((b) => b.startsWith("You need Manage Channels")));
    assert.ok(plan.blockers.some((b) => b.startsWith("You need Manage Roles")));
  });

  it("skips roles above the member, and recreated roles never get permissions they lack", () => {
    const s = server();
    // Both roles were deleted since the backup.
    const live = { ...s.snap, roles: s.snap.roles.filter((r) => r.id !== s.admin.id && r.id !== s.vip.id) };
    const plan = computeRestorePlan(s.backup, live, false, builder);
    assert.deepEqual(plan.blockers, []);
    const admin = plan.roles.find((r) => r.backupId === s.admin.id)!;
    assert.equal(BigInt(admin.permissions) & P.Administrator, 0n, "Administrator isn't recreated for a non-admin");

    const renamedAbove = { ...s.snap, roles: s.snap.roles.map((r) => (r.id === s.admin.id ? { ...r, name: "Boss" } : r)) };
    const plan2 = computeRestorePlan(s.backup, renamedAbove, false, builder);
    assert.equal(plan2.roles.find((r) => r.backupId === s.admin.id)!.action, "skip");
    assert.ok(plan2.warnings.some((w) => w.includes("at or above your highest role")));
  });

  it("removing what was added needs Administrator or the owner", () => {
    const s = server();
    const extra = channel("new-stuff", "text");
    const live = { ...s.snap, channels: [...s.snap.channels, extra] };
    const plan = computeRestorePlan(s.backup, live, true, builder);
    assert.ok(plan.blockers.some((b) => b.includes("needs Administrator or the server owner")));
    assert.deepEqual(computeRestorePlan(s.backup, live, true, { ...builder, owner: true }).blockers, []);
  });
});
