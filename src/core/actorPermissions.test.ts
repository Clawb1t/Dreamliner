import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits, type Guild } from "discord.js";
import {
  ActorPermissionError,
  actorRoleProblem,
  assertGrantableRoles,
  canActorManageRole,
  createRoleGrantGuard,
  missingActorPermissions,
  requireActorPermissions,
  resolveActor,
  type ActorInfo,
  type ActorRoleTarget,
} from "./actorPermissions.js";

const GUILD_ID = "100000000000000001";
const P = PermissionFlagsBits;

function actor(patch: Partial<ActorInfo> = {}): ActorInfo {
  return { userId: "200000000000000001", owner: false, administrator: false, superuser: false, permissions: P.ManageGuild, highestPosition: 5, ...patch };
}

function role(patch: Partial<ActorRoleTarget> = {}): ActorRoleTarget {
  return { id: "300000000000000001", name: "Member", position: 2, managed: false, permissions: P.SendMessages, ...patch };
}

describe("actorRoleProblem", () => {
  const manager = actor({ permissions: P.ManageGuild | P.ManageRoles | P.SendMessages, highestPosition: 5 });

  it("lets a member with Manage Roles use a role below them with permissions they have", () => {
    assert.equal(actorRoleProblem(manager, role({ position: 4 }), GUILD_ID), null);
  });

  it("refuses roles at or above the member's highest role", () => {
    assert.match(actorRoleProblem(manager, role({ position: 5, name: "Equal" }), GUILD_ID)!, /@Equal is at or above your highest role/);
    assert.match(actorRoleProblem(manager, role({ position: 9, name: "Above" }), GUILD_ID)!, /@Above is at or above/);
  });

  it("refuses without Manage Roles (Manage Server alone isn't enough)", () => {
    const manageServerOnly = actor({ permissions: P.ManageGuild, highestPosition: 8 });
    assert.match(actorRoleProblem(manageServerOnly, role({ position: 1 }), GUILD_ID)!, /You need Manage Roles/);
  });

  it("refuses roles with permissions the member lacks", () => {
    const problem = actorRoleProblem(manager, role({ position: 1, name: "Mod", permissions: P.BanMembers | P.SendMessages }), GUILD_ID);
    assert.match(problem!, /@Mod has a permission you don't have \(Ban Members\)/);
  });

  it("never allows managed roles or @everyone, not even for the owner", () => {
    const owner = actor({ owner: true });
    assert.match(actorRoleProblem(owner, role({ managed: true, name: "Bot" }), GUILD_ID)!, /managed by an integration/);
    assert.match(actorRoleProblem(owner, role({ id: GUILD_ID, name: "@everyone" }), GUILD_ID)!, /@everyone can't be given/);
  });

  it("the owner passes the hierarchy and permission checks", () => {
    const owner = actor({ owner: true, permissions: 0n, highestPosition: 0 });
    assert.equal(actorRoleProblem(owner, role({ position: 50, permissions: P.Administrator }), GUILD_ID), null);
  });

  it("Administrator passes permission checks but not the hierarchy", () => {
    const admin = actor({ administrator: true, permissions: P.Administrator, highestPosition: 5 });
    assert.equal(actorRoleProblem(admin, role({ position: 4, permissions: P.BanMembers | P.ManageGuild }), GUILD_ID), null);
    assert.match(actorRoleProblem(admin, role({ position: 5 }), GUILD_ID)!, /at or above your highest role/);
    assert.match(actorRoleProblem(admin, role({ position: 7 }), GUILD_ID)!, /at or above your highest role/);
  });
});

describe("missingActorPermissions", () => {
  it("names what's missing; owner and admin have everything", () => {
    assert.deepEqual(missingActorPermissions(actor({ permissions: P.ManageGuild | P.ManageChannels }), ["ManageChannels", "ManageRoles"]), ["ManageRoles"]);
    assert.deepEqual(missingActorPermissions(actor({ owner: true, permissions: 0n }), ["ManageRoles", "BanMembers"]), []);
    assert.deepEqual(missingActorPermissions(actor({ administrator: true }), ["ManageWebhooks"]), []);
  });
});

// ── Live-guild helpers, against a small fake guild ─────────────────────────────

type FakeMember = { id: string; perms: bigint; top: number };

function fakeGuild(opts: { ownerId?: string; members: FakeMember[]; roles: ActorRoleTarget[] }): Guild {
  const guild = { id: GUILD_ID, ownerId: opts.ownerId ?? "999999999999999999" } as Record<string, unknown>;
  const members = new Map(
    opts.members.map((m) => [m.id, { id: m.id, guild, permissions: { bitfield: m.perms }, roles: { highest: { position: m.top } } }]),
  );
  const roles = new Map(opts.roles.map((r) => [r.id, { id: r.id, name: r.name, position: r.position, managed: r.managed, permissions: { bitfield: r.permissions } }]));
  guild.members = { cache: members, fetch: async (id: string) => members.get(id) ?? Promise.reject(new Error("Unknown Member")) };
  guild.roles = { cache: roles };
  return guild as unknown as Guild;
}

const MOD = "400000000000000001";
const MANAGER = "400000000000000002";
const ADMIN_ROLE = role({ id: "500000000000000001", name: "Admin", position: 9, permissions: P.Administrator });
const VIP_ROLE = role({ id: "500000000000000002", name: "VIP", position: 2, permissions: P.SendMessages });

describe("resolveActor / requireActorPermissions / assertGrantableRoles", () => {
  const guild = fakeGuild({
    members: [
      { id: MOD, perms: P.ManageGuild | P.ManageRoles | P.SendMessages, top: 5 },
      { id: MANAGER, perms: P.ManageGuild, top: 5 },
    ],
    roles: [ADMIN_ROLE, VIP_ROLE],
  });

  it("denies when the member can't be resolved", async () => {
    assert.equal(await resolveActor(guild, "400000000000000099"), null);
    await assert.rejects(requireActorPermissions(guild, "400000000000000099", ["ManageChannels"], "create channels"), (e: unknown) => e instanceof ActorPermissionError && e.code === "actor_unresolved");
  });

  it("refuses with a clear message naming the missing permission", async () => {
    await assert.rejects(requireActorPermissions(guild, MANAGER, ["ManageChannels", "ManageRoles"], "build channels"), (e: unknown) => {
      assert.ok(e instanceof ActorPermissionError);
      assert.equal(e.status, 403);
      assert.deepEqual(e.missing, ["Manage Channels", "Manage Roles"]);
      assert.match(e.message, /^You need Manage Channels and Manage Roles to build channels\./);
      return true;
    });
    assert.equal((await requireActorPermissions(guild, MOD, ["ManageRoles"], "build roles")).userId, MOD);
  });

  it("canActorManageRole / assertGrantableRoles check the hierarchy", async () => {
    assert.deepEqual(await canActorManageRole(guild, MOD, VIP_ROLE.id), { ok: true });
    assert.equal((await canActorManageRole(guild, MOD, ADMIN_ROLE.id)).ok, false);
    await assertGrantableRoles(guild, MOD, [VIP_ROLE.id]);
    await assert.rejects(assertGrantableRoles(guild, MOD, [ADMIN_ROLE.id]), (e: unknown) => e instanceof ActorPermissionError && e.code === "role_hierarchy");
    await assert.rejects(assertGrantableRoles(guild, MANAGER, [VIP_ROLE.id]), /You need Manage Roles/);
  });

  it("the config guard checks roles and Manage Channels", async () => {
    const guard = createRoleGrantGuard({ guilds: { cache: new Map([[GUILD_ID, guild]]) } });
    assert.deepEqual(await guard(GUILD_ID, MOD, { roleIds: [VIP_ROLE.id], channelIds: [] }), []);
    const problems = await guard(GUILD_ID, MOD, { roleIds: [ADMIN_ROLE.id], channelIds: ["600000000000000001"] });
    assert.ok(problems.some((p) => /Manage Channels/.test(p)));
    assert.ok(problems.some((p) => /@Admin is at or above your highest role/.test(p)));
  });
});
