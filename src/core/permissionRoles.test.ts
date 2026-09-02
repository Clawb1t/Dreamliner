import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB for this test file — Node's test runner gives each matched test file its
// own process, so setting DATABASE_URL here (before any getDb() call) doesn't affect other test
// files. Set before importing anything that transitively calls getDb() at module scope (nothing
// here does — getDb() is always called lazily, inside a function body).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-permission-roles-test-"));
const dbPath = join(scratchDir, "test.db");
process.env.DATABASE_URL = `file:${dbPath}`;

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();

const { permissionRoleManager } = await import("../config/permissionRoleManager.js");
const { hasAdminBypass, hasPermission, getMemberPermissionRoles } = await import("./permissionRoles.js");
const { grantKeyFor } = await import("./permissionCatalog.js");
const { zGuildConfig } = await import("../config/schemas/guild.js");
const { getDb } = await import("../db/client.js");

after(() => {
  // better-sqlite3 keeps a live file handle; close it first or the directory removal below
  // fails silently on Windows (the file stays locked).
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* best effort — leftover temp dir is harmless */
  }
});

const guildConfig = zGuildConfig.parse({});

/** Minimal duck-typed GuildMember stand-in — only the shape hasPermission/getMemberPermissionRoles actually reads. */
function fakeMember(opts: { id: string; roleIds?: string[]; ownerId?: string; isAdmin?: boolean }) {
  const roleIds = new Set(opts.roleIds ?? []);
  return {
    id: opts.id,
    guild: { id: "guild-1", ownerId: opts.ownerId ?? "owner-1" },
    roles: { cache: { has: (id: string) => roleIds.has(id) } },
    permissions: { has: () => opts.isAdmin === true },
  } as unknown as import("discord.js").GuildMember;
}

describe("permission role manager", () => {
  const guildId = "test-guild-1";

  it("seeds Member/Moderator/Admin exactly once and is idempotent", async () => {
    const first = await permissionRoleManager.listRoles(guildId);
    assert.equal(first.length, 3);
    assert.deepEqual(
      first.map((r) => r.builtIn).sort(),
      ["admin", "member", "moderator"],
    );
    const second = await permissionRoleManager.listRoles(guildId);
    assert.equal(second.length, 3);
  });

  it("Member's grants apply to every member with no target assignment needed", async () => {
    const roles = await permissionRoleManager.listRoles(guildId);
    const member = roles.find((r) => r.builtIn === "member")!;
    await permissionRoleManager.setGrant(guildId, member.id, "utility.can_ping", true, "tester");

    const someRandomMember = fakeMember({ id: "random-member" });
    assert.equal(await hasPermission(guildId, "utility", "can_ping", someRandomMember, guildConfig), true);
    assert.equal(await hasPermission(guildId, "utility", "can_reload_guild", someRandomMember, guildConfig), false);
  });

  it("grants via a Discord role target OR a direct user target", async () => {
    const custom = await permissionRoleManager.createRole(guildId, "Custom", "tester");
    await permissionRoleManager.setGrant(guildId, custom.id, grantKeyFor("utility", "can_search"), true, "tester");
    await permissionRoleManager.setTargets(guildId, custom.id, [{ type: "role", id: "discord-role-mod" }], "tester");

    const memberWithRole = fakeMember({ id: "u1", roleIds: ["discord-role-mod"] });
    const memberWithoutRole = fakeMember({ id: "u2" });
    assert.equal(await hasPermission(guildId, "utility", "can_search", memberWithRole, guildConfig), true);
    assert.equal(await hasPermission(guildId, "utility", "can_search", memberWithoutRole, guildConfig), false);

    await permissionRoleManager.setTargets(guildId, custom.id, [{ type: "user", id: "u2" }], "tester");
    assert.equal(await hasPermission(guildId, "utility", "can_search", memberWithRole, guildConfig), false);
    assert.equal(await hasPermission(guildId, "utility", "can_search", memberWithoutRole, guildConfig), true);
  });

  it("ORs grants across every role a member belongs to", async () => {
    const roleA = await permissionRoleManager.createRole(guildId, "RoleA", "tester");
    const roleB = await permissionRoleManager.createRole(guildId, "RoleB", "tester");
    await permissionRoleManager.setGrant(guildId, roleA.id, grantKeyFor("stats", "can_server"), true, "tester");
    await permissionRoleManager.setGrant(guildId, roleB.id, grantKeyFor("stats", "can_user"), true, "tester");
    await permissionRoleManager.setTargets(guildId, roleA.id, [{ type: "user", id: "u3" }], "tester");
    await permissionRoleManager.setTargets(guildId, roleB.id, [{ type: "user", id: "u3" }], "tester");

    const member = fakeMember({ id: "u3" });
    assert.equal(await hasPermission(guildId, "stats", "can_server", member, guildConfig), true);
    assert.equal(await hasPermission(guildId, "stats", "can_user", member, guildConfig), true);
    assert.equal(await hasPermission(guildId, "stats", "can_channel", member, guildConfig), false);

    const memberRoles = await getMemberPermissionRoles(guildId, member);
    const names = memberRoles.map((r) => r.name);
    assert.ok(names.includes("RoleA"));
    assert.ok(names.includes("RoleB"));
    assert.ok(names.includes("Member"));
  });

  it("admin_bypass grants everything to the owner/Administrator regardless of role assignment", async () => {
    const owner = fakeMember({ id: "owner-1", ownerId: "owner-1" });
    assert.equal(hasAdminBypass(owner, guildConfig), true);
    assert.equal(await hasPermission(guildId, "utility", "can_reload_guild", owner, guildConfig), true);

    const admin = fakeMember({ id: "admin-1", isAdmin: true });
    assert.equal(hasAdminBypass(admin, guildConfig), true);

    const disabledBypass = zGuildConfig.parse({ admin_bypass: false });
    assert.equal(hasAdminBypass(admin, disabledBypass), false);
  });

  it("can't delete or assign targets to a built-in role", async () => {
    const roles = await permissionRoleManager.listRoles(guildId);
    const member = roles.find((r) => r.builtIn === "member")!;
    const deleteResult = await permissionRoleManager.deleteRole(guildId, member.id, "tester");
    assert.equal(deleteResult.success, false);

    const setTargetsResult = await permissionRoleManager.setTargets(guildId, member.id, [{ type: "user", id: "x" }], "tester");
    assert.equal(setTargetsResult.success, false);
  });

  it("deletes a custom role and its targets/grants", async () => {
    const custom = await permissionRoleManager.createRole(guildId, "Temp", "tester");
    await permissionRoleManager.setGrant(guildId, custom.id, "utility.can_ping", true, "tester");
    const result = await permissionRoleManager.deleteRole(guildId, custom.id, "tester");
    assert.equal(result.success, true);
    const fetched = await permissionRoleManager.getRole(guildId, custom.id);
    assert.equal(fetched, null);
  });
});
