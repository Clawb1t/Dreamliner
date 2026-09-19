import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.DASHBOARD_BRIDGE_SECRET = "test-secret";

const { issueWizardSessionToken, verifyWizardSessionToken } = await import("./wizardSession.js");

describe("wizard session tokens", () => {
  it("accepts a freshly issued token for its own guild", () => {
    const token = issueWizardSessionToken("guild-1");
    assert.equal(verifyWizardSessionToken("guild-1", token), true);
  });

  it("rejects a token for a different guild", () => {
    const token = issueWizardSessionToken("guild-1");
    assert.equal(verifyWizardSessionToken("guild-2", token), false);
  });

  it("rejects a tampered token", () => {
    const token = issueWizardSessionToken("guild-1");
    const tampered = `${token.slice(0, -1)}${token.at(-1) === "a" ? "b" : "a"}`;
    assert.equal(verifyWizardSessionToken("guild-1", tampered), false);
  });

  it("rejects a missing token", () => {
    assert.equal(verifyWizardSessionToken("guild-1", undefined), false);
  });
});
