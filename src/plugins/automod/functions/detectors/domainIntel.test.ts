import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreDomainHeuristics } from "./domainIntel.js";

describe("scoreDomainHeuristics", () => {
  it("scores a normal domain as clean", () => {
    const { score, reasons } = scoreDomainHeuristics("example.com");
    assert.equal(score, 0);
    assert.deepEqual(reasons, []);
  });

  it("flags a raw IP address", () => {
    const { score, reasons } = scoreDomainHeuristics("192.168.1.10");
    assert.ok(score >= 4);
    assert.ok(reasons.some((r) => r.includes("IP address")));
  });

  it("flags punycode lookalike hosts", () => {
    const { score, reasons } = scoreDomainHeuristics("xn--discrd-i8a.com");
    assert.ok(score >= 3);
    assert.ok(reasons.some((r) => r.includes("punycode")));
  });

  it("flags risky free TLDs", () => {
    const { score, reasons } = scoreDomainHeuristics("free-nitro-gift.tk");
    assert.ok(score > 0);
    assert.ok(reasons.some((r) => r.includes(".tk")));
  });

  it("flags brand impersonation on a lookalike domain", () => {
    const { score, reasons } = scoreDomainHeuristics("discord-nitro-gift.top");
    assert.ok(score >= 3);
    assert.ok(reasons.some((r) => r.includes("discord")));
  });

  it("does not flag the real brand domain", () => {
    const { score, reasons } = scoreDomainHeuristics("discord.com");
    assert.equal(score, 0);
    assert.deepEqual(reasons, []);
  });

  it("does not flag a subdomain of the real brand domain", () => {
    const { score } = scoreDomainHeuristics("status.discord.com");
    assert.equal(score, 0);
  });

  it("adds up multiple signals", () => {
    const { score, reasons } = scoreDomainHeuristics("free-discord-nitro-gift-claim.xyz");
    assert.ok(score >= 5);
    assert.ok(reasons.length >= 2);
  });
});
