import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { previewIdentityRestore, type RestorePreviewInput, type RestoreRoleFacts } from "./preview.js";

const GUILD = "100000000000000000";
const NOW = 1_800_000_000_000;

function roles(...list: RestoreRoleFacts[]): Map<string, RestoreRoleFacts> {
  return new Map(list.map((role) => [role.id, role]));
}

function input(overrides: Partial<RestorePreviewInput> = {}): RestorePreviewInput {
  return {
    pluginEnabled: true,
    config: {
      restore_nickname: true,
      restore_roles: true,
      restore_timeout: false,
      skip_managed_roles: true,
      ignore_bots: true,
      ignored_roles: [],
    },
    snapshot: { nickname: "Captain", roleIds: ["1", "2"], timeoutUntil: null },
    roles: roles(
      { id: "1", exists: true, managed: false, position: 3 },
      { id: "2", exists: true, managed: false, position: 5 },
    ),
    bot: { highestPosition: 10, manageRoles: true, manageNicknames: true, moderateMembers: true },
    targetIsBot: false,
    targetIsOwner: false,
    guildId: GUILD,
    now: NOW,
    ...overrides,
  };
}

describe("previewIdentityRestore", () => {
  it("restores nickname and roles with the default settings", () => {
    const result = previewIdentityRestore(input());
    assert.equal(result.anything, true);
    assert.equal(result.blockedReason, null);
    assert.deepEqual(result.nickname, { restores: true, reason: null });
    assert.deepEqual(result.timeout, { restores: false, reason: "restore_off" });
    assert.deepEqual(
      result.roles.map((role) => [role.id, role.restores]),
      [
        ["1", true],
        ["2", true],
      ],
    );
  });

  it("blocks everything when the plugin is off", () => {
    const result = previewIdentityRestore(input({ pluginEnabled: false }));
    assert.equal(result.anything, false);
    assert.equal(result.blockedReason, "plugin_off");
    assert.ok(result.roles.every((role) => role.reason === "plugin_off"));
    assert.equal(result.nickname.reason, "plugin_off");
  });

  it("blocks bots when ignore_bots is on", () => {
    const result = previewIdentityRestore(input({ targetIsBot: true }));
    assert.equal(result.blockedReason, "bots_ignored");
    assert.equal(result.anything, false);
  });

  it("gives each role its own reason", () => {
    const result = previewIdentityRestore(
      input({
        config: { ...input().config, ignored_roles: ["4"] },
        snapshot: { nickname: "", roleIds: [GUILD, "1", "2", "3", "4", "5", "6"], timeoutUntil: null },
        roles: roles(
          { id: "1", exists: true, managed: false, position: 3 },
          { id: "2", exists: true, managed: false, position: 10 },
          { id: "3", exists: true, managed: true, position: 1 },
          { id: "4", exists: true, managed: false, position: 2 },
          { id: "5", exists: false, managed: false, position: 0 },
        ),
      }),
    );
    assert.deepEqual(
      result.roles.map((role) => [role.id, role.reason]),
      [
        ["1", null],
        ["2", "above_bot"],
        ["3", "managed"],
        ["4", "ignored"],
        ["5", "deleted"],
        ["6", "deleted"],
      ],
    );
    assert.equal(result.nickname.reason, "nothing_saved");
  });

  it("marks roles restore_off when only role restore is turned off", () => {
    const result = previewIdentityRestore(input({ config: { ...input().config, restore_roles: false } }));
    assert.ok(result.roles.every((role) => role.reason === "restore_off"));
    assert.equal(result.nickname.restores, true);
    assert.equal(result.anything, true);
  });

  it("needs Manage Roles and Manage Nicknames", () => {
    const result = previewIdentityRestore(
      input({ bot: { highestPosition: 10, manageRoles: false, manageNicknames: false, moderateMembers: false } }),
    );
    assert.ok(result.roles.every((role) => role.reason === "no_permission"));
    assert.equal(result.nickname.reason, "no_permission");
    assert.equal(result.anything, false);
  });

  it("never changes the owner's nickname", () => {
    assert.equal(previewIdentityRestore(input({ targetIsOwner: true })).nickname.reason, "owner");
  });

  it("restores a timeout only while it is still running", () => {
    const config = { ...input().config, restore_timeout: true };
    const running = previewIdentityRestore(
      input({ config, snapshot: { nickname: "", roleIds: [], timeoutUntil: NOW + 60_000 } }),
    );
    assert.deepEqual(running.timeout, { restores: true, reason: null });
    const expired = previewIdentityRestore(
      input({ config, snapshot: { nickname: "", roleIds: [], timeoutUntil: NOW - 1 } }),
    );
    assert.equal(expired.timeout.reason, "expired");
    assert.equal(expired.anything, false);
  });
});
