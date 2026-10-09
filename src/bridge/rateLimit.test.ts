import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bridgeRateLimit, SlidingWindowLimiter } from "./rateLimit.js";

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit, then refuses with a retry time", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    const t = 1_000_000;
    assert.equal(limiter.take("a", t).ok, true);
    assert.equal(limiter.take("a", t).ok, true);
    assert.equal(limiter.take("a", t).ok, true);
    const blocked = limiter.take("a", t + 10);
    assert.equal(blocked.ok, false);
    assert.ok(!blocked.ok && blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
  });

  it("keeps keys separate", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    assert.equal(limiter.take("a", 0).ok, true);
    assert.equal(limiter.take("b", 0).ok, true);
    assert.equal(limiter.take("a", 0).ok, false);
  });

  it("weighs the previous window, then forgets it", () => {
    const limiter = new SlidingWindowLimiter(10, 60_000);
    for (let i = 0; i < 10; i++) limiter.take("a", 0);
    // Just into the next window most of the last one still counts: room for one more, not ten.
    assert.equal(limiter.take("a", 61_000).ok, true);
    assert.equal(limiter.take("a", 61_000).ok, false);
    // Two windows later it's all clear.
    assert.equal(limiter.take("a", 125_000).ok, true);
  });

  it("check() doesn't count and reset() clears", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    assert.equal(limiter.check("a", 0), true);
    assert.equal(limiter.check("a", 0), true);
    limiter.take("a", 0);
    assert.equal(limiter.check("a", 0), false);
    limiter.reset("a");
    assert.equal(limiter.check("a", 0), true);
  });
});

describe("bridgeRateLimit", () => {
  it("never limits anonymous reads", () => {
    const url = new URL("http://x/bridge/guilds/123456789012345678/home");
    for (let i = 0; i < 6000; i++) assert.equal(bridgeRateLimit("GET", url), null);
  });

  it("limits a user's AI calls well before their reads", () => {
    const user = "900000000000000001";
    const ai = new URL(`http://x/bridge/guilds/123456789012345678/ai/copy?userId=${user}`);
    let limitedAt = -1;
    for (let i = 0; i < 100; i++) {
      if (bridgeRateLimit("POST", ai) !== null) {
        limitedAt = i;
        break;
      }
    }
    assert.equal(limitedAt, 40);
    const read = new URL(`http://x/bridge/guilds/123456789012345678/stats?userId=${user}`);
    assert.equal(bridgeRateLimit("GET", read), null);
  });
});
