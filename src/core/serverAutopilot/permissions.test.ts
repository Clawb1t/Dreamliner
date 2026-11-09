import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits as P } from "discord.js";
import {
  PERMISSION_FLAGS,
  PERMISSION_PRESETS,
  accessOverwrites,
  allowedExtraPermissions,
  channelAccessOverwrites,
  planCategoryOverwrites,
  planChannelOverwrites,
  samePlannedOverwrites,
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

describe("channelAccessOverwrites", () => {
  const ctx = { roles, voice: false };
  const VIEW = P.ViewChannel;
  const SEND = P.SendMessages;
  const everyoneOf = (list: ReturnType<typeof accessOverwrites>) => list.find((o) => o.target.kind === "everyone");
  const roleOf = (list: ReturnType<typeof accessOverwrites>, key: string) => list.find((o) => o.target.kind === "role" && o.target.key === key);

  it("keeps a read-only channel in a staff-only category hidden", () => {
    const list = channelAccessOverwrites({ access: "read_only", roleKeys: [] }, { access: "staff_only", roleKeys: [] }, ctx);
    assert.equal(everyoneOf(list)!.deny & VIEW, VIEW, "hidden from everyone");
    assert.equal(everyoneOf(list)!.deny & SEND, SEND);
    assert.equal(roleOf(list, "mod")!.allow & (VIEW | SEND), VIEW | SEND, "staff see and post");
    assert.ok(list.some((o) => o.target.kind === "bot"));
  });
  it("a staff-only channel in a verified category doesn't let verified members in", () => {
    const list = channelAccessOverwrites({ access: "staff_only", roleKeys: [] }, { access: "verified_only", roleKeys: [] }, ctx);
    assert.equal(roleOf(list, "verified"), undefined);
    assert.equal(everyoneOf(list)!.deny & VIEW, VIEW);
  });
  it("a read-only channel in a verified category stays verified-only and read-only", () => {
    const list = channelAccessOverwrites({ access: "read_only", roleKeys: [] }, { access: "verified_only", roleKeys: [] }, ctx);
    assert.equal(everyoneOf(list)!.deny & (VIEW | SEND), VIEW | SEND);
    assert.equal(roleOf(list, "verified")!.allow & VIEW, VIEW);
    assert.equal(roleOf(list, "verified")!.allow & SEND, 0n, "verified members read only");
    assert.equal(roleOf(list, "mod")!.allow & SEND, SEND);
  });
  it("a VIP-only category keeps a read-only channel read-only for VIPs", () => {
    const list = channelAccessOverwrites({ access: "read_only", roleKeys: [] }, { access: "hidden_roles", roleKeys: ["vip"] }, ctx);
    assert.equal(roleOf(list, "vip")!.allow & VIEW, VIEW);
    assert.equal(roleOf(list, "vip")!.allow & SEND, 0n);
  });
  it("muted stays muted after the posting rules are applied", () => {
    const list = channelAccessOverwrites({ access: "roles", roleKeys: ["muted", "vip"] }, { access: "verified_only", roleKeys: [] }, ctx);
    assert.equal(roleOf(list, "muted")!.allow & SEND, 0n);
    assert.equal(roleOf(list, "muted")!.deny & SEND, SEND);
  });
  it("matches the category exactly when nothing differs, so the channel can sync", () => {
    const category = accessOverwrites("staff_only", [], { roles, voice: false });
    const list = channelAccessOverwrites({ access: "staff_only", roleKeys: [] }, { access: "staff_only", roleKeys: [] }, ctx);
    assert.ok(samePlannedOverwrites(list, category));
    assert.ok(!samePlannedOverwrites(channelAccessOverwrites({ access: "read_only", roleKeys: [] }, { access: "staff_only", roleKeys: [] }, ctx), category));
  });
});

describe("AI permission rules", () => {
  const find = (list: ReturnType<typeof accessOverwrites>, kind: string, key?: string) =>
    list.find((o) => o.target.kind === kind && (key === undefined || (o.target.kind === "role" && o.target.key === key)));

  it("applies per-role capabilities on top of the access level", () => {
    const cat = planCategoryOverwrites({ access: "everyone", roleKeys: [], rules: [{ target: "everyone", allow: [], deny: ["files"] }, { target: "member", allow: ["files", "embeds"], deny: [] }] }, [...roles, { key: "member", preset: "member" }]);
    assert.equal(find(cat, "everyone")!.deny & P.AttachFiles, P.AttachFiles);
    assert.equal(find(cat, "role", "member")!.allow & (P.AttachFiles | P.EmbedLinks), P.AttachFiles | P.EmbedLinks);
  });
  it("never lets a rule open a staff-only place", () => {
    const cat = planCategoryOverwrites({ access: "staff_only", roleKeys: [], rules: [{ target: "everyone", allow: ["view", "chat"], deny: [] }, { target: "vip", allow: ["view"], deny: [] }] }, roles);
    assert.equal(find(cat, "everyone")!.deny & P.ViewChannel, P.ViewChannel);
    assert.equal(find(cat, "everyone")!.allow & P.ViewChannel, 0n);
    assert.equal((find(cat, "role", "vip")?.allow ?? 0n) & P.ViewChannel, 0n);
    assert.ok(find(cat, "bot"));
  });
  it("a channel can't show itself to roles its category hides it from", () => {
    const category = planCategoryOverwrites({ access: "staff_only", roleKeys: [], rules: [] }, roles);
    const list = planChannelOverwrites(
      { access: "everyone", roleKeys: [], rules: [{ target: "everyone", allow: ["view"], deny: [] }, { target: "verified", allow: ["view", "chat"], deny: [] }] },
      { access: "staff_only", roleKeys: [], rules: [], planned: category },
      roles,
      false,
    );
    assert.equal(find(list, "everyone")!.deny & P.ViewChannel, P.ViewChannel);
    assert.equal((find(list, "role", "verified")?.allow ?? 0n) & P.ViewChannel, 0n);
  });
  it("a category hidden only by a rule still hides its channels", () => {
    const category = planCategoryOverwrites({ access: "everyone", roleKeys: [], rules: [{ target: "everyone", allow: [], deny: ["view"] }, { target: "vip", allow: ["view"], deny: [] }] }, roles);
    assert.ok(find(category, "bot"), "the bot keeps access");
    const list = planChannelOverwrites({ access: "read_only", roleKeys: [], rules: [] }, { access: "everyone", roleKeys: [], rules: [{ target: "everyone", allow: [], deny: ["view"] }, { target: "vip", allow: ["view"], deny: [] }], planned: category }, roles, false);
    assert.equal(find(list, "everyone")!.deny & P.ViewChannel, P.ViewChannel);
    assert.equal(find(list, "role", "vip")!.allow & P.ViewChannel, P.ViewChannel);
  });
  it("moderation only goes to staff, and muted stays muted", () => {
    const cat = planCategoryOverwrites(
      { access: "everyone", roleKeys: [], rules: [{ target: "vip", allow: ["moderate", "ping_everyone"], deny: [] }, { target: "mod", allow: ["moderate"], deny: [] }, { target: "muted", allow: ["chat"], deny: [] }] },
      roles,
    );
    assert.equal((find(cat, "role", "vip")?.allow ?? 0n) & (P.ManageMessages | P.MentionEveryone), 0n);
    assert.equal(find(cat, "role", "mod")!.allow & P.ManageMessages, P.ManageMessages);
    assert.equal(find(cat, "role", "muted")!.allow & P.SendMessages, 0n);
  });
  it("a channel with no access or rules of its own is synced", () => {
    const category = planCategoryOverwrites({ access: "verified_only", roleKeys: [], rules: [{ target: "everyone", allow: [], deny: ["threads"] }] }, roles);
    const list = planChannelOverwrites({ access: "everyone", roleKeys: [], rules: [] }, { access: "verified_only", roleKeys: [], rules: [{ target: "everyone", allow: [], deny: ["threads"] }], planned: category }, roles, false);
    assert.ok(samePlannedOverwrites(list, category));
  });
});
