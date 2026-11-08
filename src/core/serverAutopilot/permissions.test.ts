import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits as P } from "discord.js";
import {
  PERMISSION_FLAGS,
  PERMISSION_PRESETS,
  accessOverwrites,
  allowedExtraPermissions,
  clampOverwrites,
  rolePermissions,
} from "./permissions.js";
import { SA_ROLE_PRESETS } from "./types.js";

const ALL = Object.values(P).reduce((a, b) => a | b, 0n);
const roles = [
  { key: "admin", preset: "admin" as const },
  { key: "mod", preset: "moderator" as const },
  { key: "verified", preset: "verified" as const },
  { key: "vip", preset: "vip" as const },
  { key: "muted", preset: "muted" as const },
];

describe("presets", () => {
  it("never include Administrator; only owner has Manage Server", () => {
    for (const preset of SA_ROLE_PRESETS) {
      assert.equal(PERMISSION_PRESETS[preset] & P.Administrator, 0n, preset);
      if (preset !== "owner") assert.equal(PERMISSION_PRESETS[preset] & P.ManageGuild, 0n, preset);
    }
    assert.equal(PERMISSION_PRESETS.owner & P.ManageGuild, P.ManageGuild);
  });
  it("member-tier presets carry no staff permissions", () => {
    const staffBits = P.BanMembers | P.KickMembers | P.ManageRoles | P.ManageChannels | P.ModerateMembers | P.ManageMessages;
    for (const preset of ["member", "verified", "vip", "booster_like", "cosmetic", "ping", "muted", "bot"] as const) {
      assert.equal(PERMISSION_PRESETS[preset] & staffBits, 0n, preset);
    }
  });
  it("the allow-list has no Administrator or Manage Server", () => {
    assert.ok(!PERMISSION_FLAGS.includes("Administrator"));
    assert.ok(!PERMISSION_FLAGS.includes("ManageGuild"));
  });
});

describe("allowedExtraPermissions", () => {
  it("only staff presets may get dangerous extras", () => {
    assert.deepEqual(allowedExtraPermissions("member", ["BanMembers", "AttachFiles", "Administrator", "AttachFiles"]), ["AttachFiles"]);
    assert.deepEqual(allowedExtraPermissions("moderator", ["BanMembers", "Administrator", "ManageGuild"]), ["BanMembers"]);
  });
});

describe("rolePermissions", () => {
  it("is clamped to what the bot has", () => {
    const bot = P.ManageMessages | P.KickMembers;
    const result = rolePermissions({ preset: "moderator", extra_permissions: [] }, bot, false);
    assert.equal(result.permissions, P.ManageMessages | P.KickMembers);
    assert.ok(result.dropped.includes("ModerateMembers"));
  });
  it("an administrator bot can grant the full preset, still never Administrator", () => {
    const result = rolePermissions({ preset: "owner", extra_permissions: ["Administrator"] }, 0n, true);
    assert.equal(result.permissions, PERMISSION_PRESETS.owner);
    assert.deepEqual(result.dropped, []);
  });
});

describe("accessOverwrites", () => {
  const find = (list: ReturnType<typeof accessOverwrites>, kind: string, key?: string) =>
    list.find((o) => o.target.kind === kind && (key === undefined || (o.target.kind === "role" && o.target.key === key)));

  it("everyone: only the muted role is restricted", () => {
    const list = accessOverwrites("everyone", [], { roles, voice: false });
    assert.equal(list.length, 1);
    assert.equal(find(list, "role", "muted")!.deny & P.SendMessages, P.SendMessages);
  });
  it("read_only: @everyone can't post, staff can", () => {
    const list = accessOverwrites("read_only", [], { roles, voice: false });
    assert.equal(find(list, "everyone")!.deny & P.SendMessages, P.SendMessages);
    assert.equal(find(list, "everyone")!.deny & P.ViewChannel, 0n);
    assert.equal(find(list, "role", "mod")!.allow & P.SendMessages, P.SendMessages);
  });
  it("staff_only: hidden from @everyone, visible to staff and the bot", () => {
    const list = accessOverwrites("staff_only", [], { roles, voice: false });
    assert.equal(find(list, "everyone")!.deny & P.ViewChannel, P.ViewChannel);
    assert.equal(find(list, "role", "admin")!.allow & P.ViewChannel, P.ViewChannel);
    assert.equal(find(list, "role", "verified"), undefined);
    assert.equal(find(list, "bot")!.allow & P.ViewChannel, P.ViewChannel);
  });
  it("verified_only: verified and staff see it", () => {
    const list = accessOverwrites("verified_only", [], { roles, voice: false });
    assert.equal(find(list, "role", "verified")!.allow & P.ViewChannel, P.ViewChannel);
    assert.equal(find(list, "role", "mod")!.allow & P.ViewChannel, P.ViewChannel);
  });
  it("roles / hidden_roles use the listed roles; voice uses Connect", () => {
    const list = accessOverwrites("roles", ["vip"], { roles, voice: true });
    assert.equal(find(list, "everyone")!.deny & P.Connect, P.Connect);
    assert.equal(find(list, "role", "vip")!.allow & P.Connect, P.Connect);
    const hidden = accessOverwrites("hidden_roles", ["vip"], { roles, voice: false });
    assert.equal(find(hidden, "role", "vip")!.allow & P.ViewChannel, P.ViewChannel);
  });
  it("categories allow both Send and Connect but read-only denies only Send", () => {
    const list = accessOverwrites("read_only", [], { roles, voice: false, category: true });
    assert.equal(find(list, "everyone")!.deny, P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads);
    assert.equal(find(list, "role", "mod")!.allow & P.Connect, P.Connect);
  });
  it("clampOverwrites removes bits the bot lacks", () => {
    const list = accessOverwrites("staff_only", [], { roles, voice: false });
    const clamped = clampOverwrites(list, P.ViewChannel, false);
    for (const o of clamped) assert.equal((o.allow | o.deny) & ~P.ViewChannel, 0n);
    assert.deepEqual(clampOverwrites(list, 0n, true), list);
    assert.ok(ALL > 0n);
  });
});
