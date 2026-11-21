import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { PermissionFlagsBits, type Guild } from "discord.js";
import YAML from "yaml";

// Isolated scratch DB for this file (each test file runs in its own process).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-role-grant-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();
const { ConfigManager, ROLE_GRANT_REFUSED } = await import("./manager.js");
const { createRoleGrantGuard } = await import("../core/actorPermissions.js");
const { addedGrantableRoleIds, actorFromUpdatedBy, collectGrantableRoleIds } = await import("./grantableRoleFields.js");
const { addedManagedChannelIds } = await import("./managedChannelFields.js");
const { getDb } = await import("../db/client.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const P = PermissionFlagsBits;
const GUILD_ID = "110000000000000001";
const ADMIN_USER = "210000000000000001"; // has Manage Roles, top role position 10
const MANAGER = "210000000000000002"; // Manage Server + Manage Roles, top role position 5
const ADMIN_ROLE = "310000000000000001"; // position 9
const MEMBER_ROLE = "310000000000000002"; // position 2

function fakeGuild(): Guild {
  const guild = { id: GUILD_ID, ownerId: "999999999999999999" } as Record<string, unknown>;
  const member = (id: string, perms: bigint, top: number) => [id, { id, guild, permissions: { bitfield: perms }, roles: { highest: { position: top } } }] as const;
  const members = new Map([member(ADMIN_USER, P.ManageGuild | P.ManageRoles | P.ManageChannels | P.KickMembers, 10), member(MANAGER, P.ManageGuild | P.ManageRoles, 5)]);
  const role = (id: string, name: string, position: number, perms: bigint) => [id, { id, name, position, managed: false, permissions: { bitfield: perms } }] as const;
  const roles = new Map([role(ADMIN_ROLE, "Admin", 9, P.KickMembers), role(MEMBER_ROLE, "Member", 2, 0n)]);
  guild.members = { cache: members, fetch: async (id: string) => members.get(id as never) ?? Promise.reject(new Error("Unknown Member")) };
  guild.roles = { cache: roles };
  return guild as unknown as Guild;
}

const autoroles = (roles: string[]) => YAML.stringify({ plugins: { autorole: { enabled: true, config: { roles } } } });

describe("grantable role fields", () => {
  it("collects ids from lists, nested entries and autorole objects", () => {
    const ids = collectGrantableRoleIds({
      plugins: {
        autorole: { config: { roles: ["310000000000000003", { role: "310000000000000004", delay_ms: 0 }] } },
        activity_rewards: { config: { milestones: [{ roles: ["310000000000000005"], remove_roles: [] }] } },
        role_panels: { config: { panels: [{ roles: [{ role_id: "310000000000000006" }] }] } },
        team_control: { config: { ranks: [{ role_id: "310000000000000007" }], shifts: { duty_role_id: null } } },
      },
    });
    assert.deepEqual([...ids].sort(), ["310000000000000003", "310000000000000004", "310000000000000005", "310000000000000006", "310000000000000007"]);
  });

  it("only reports newly added ids", () => {
    const before = { plugins: { autorole: { config: { roles: [ADMIN_ROLE] } } } };
    const next = { plugins: { autorole: { config: { roles: [ADMIN_ROLE, MEMBER_ROLE] } } } };
    assert.deepEqual(addedGrantableRoleIds(before, next), [MEMBER_ROLE]);
  });

  it("reads the actor from updatedBy, including saves made on someone's behalf", () => {
    assert.equal(actorFromUpdatedBy(MANAGER), MANAGER);
    assert.equal(actorFromUpdatedBy(`system:server-autopilot:${MANAGER}`), MANAGER);
    assert.equal(actorFromUpdatedBy(`system:snapshot-rollback:${MANAGER}`), MANAGER);
    assert.equal(actorFromUpdatedBy("system:scam_protect"), null);
  });

  it("managed channel fields: renaming counters count, message counters don't", () => {
    const next = { plugins: { counters: { config: { counters: [{ display: "channel_name", channel_id: "410000000000000001" }, { display: "message", channel_id: "410000000000000002" }] } } } };
    assert.deepEqual(addedManagedChannelIds({}, next), ["410000000000000001"]);
  });
});

describe("ConfigManager.saveGuildConfig with the role-grant guard", () => {
  const manager = new ConfigManager();
  manager.setRoleGrantGuard(createRoleGrantGuard({ guilds: { cache: new Map([[GUILD_ID, fakeGuild()]]) } }));

  it("refuses an autorole above the saver's highest role", async () => {
    const result = await manager.saveGuildConfig(GUILD_ID, autoroles([ADMIN_ROLE]), MANAGER);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, ROLE_GRANT_REFUSED);
    assert.ok(result.errors.some((e) => e.includes("@Admin is at or above your highest role")));
  });

  it("keeps an existing above-hierarchy autorole working when someone lower saves other changes", async () => {
    // Someone higher up configured it.
    assert.equal((await manager.saveGuildConfig(GUILD_ID, autoroles([ADMIN_ROLE]), ADMIN_USER)).success, true);
    // The manager adds a role below them; the Admin autorole is unchanged, so it isn't rechecked.
    const result = await manager.saveGuildConfig(GUILD_ID, autoroles([ADMIN_ROLE, MEMBER_ROLE]), MANAGER);
    assert.equal(result.success, true);
  });

  it("doesn't check automatic system saves", async () => {
    const result = await manager.saveGuildConfig("110000000000000002", autoroles([ADMIN_ROLE]), "system:auto-onboard");
    assert.equal(result.success, true);
  });

  it("dashboard saves can't repoint the bot-owned Scam Protect channel", async () => {
    const guildId = "110000000000000003";
    const set = (id: string) => YAML.stringify({ plugins: { scam_protect: { enabled: false, config: { channel_id: id } } } });
    await manager.saveGuildConfig(guildId, set("510000000000000001"), "system:scam_protect");
    const result = await manager.saveGuildConfig(guildId, set("510000000000000099"), MANAGER);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.plugins.scam_protect.config.channel_id, "510000000000000001");
  });
});
