import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zImpersonationConfig } from "../../../config/schemas/impersonation.js";
import { mergeProtectedRoles, withTeamRankProtection } from "./teamProtection.js";

describe("protect_team_ranks", () => {
  it("defaults off", () => {
    assert.equal(zImpersonationConfig.parse({}).protect_team_ranks, false);
  });

  it("merges rank roles into protected roles without duplicates", () => {
    assert.deepEqual(mergeProtectedRoles(["1", "2"], ["2", "3", "3"]), ["1", "2", "3"]);
    assert.deepEqual(mergeProtectedRoles([], []), []);
  });

  it("leaves the config untouched when the toggle is off", async () => {
    const config = zImpersonationConfig.parse({ protected_roles: ["1"] });
    assert.equal(await withTeamRankProtection("100000000000000001", config), config);
  });
});
