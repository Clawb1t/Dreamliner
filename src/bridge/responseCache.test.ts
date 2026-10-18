import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cached, cachedSwr, invalidateCached } from "./responseCache.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("response cache (stale-while-revalidate)", () => {
  it("serves a fresh value without recomputing", async () => {
    invalidateCached();
    let calls = 0;
    const compute = async () => ++calls;
    assert.equal(await cached("fresh", 1000, compute), 1);
    assert.equal(await cached("fresh", 1000, compute), 1);
    assert.equal(calls, 1);
  });

  it("shares one computation between concurrent callers", async () => {
    invalidateCached();
    let calls = 0;
    const compute = async () => {
      calls++;
      await sleep(30);
      return "value";
    };
    const results = await Promise.all([cached("shared", 1000, compute), cached("shared", 1000, compute), cached("shared", 1000, compute)]);
    assert.deepEqual(results, ["value", "value", "value"]);
    assert.equal(calls, 1);
  });

  it("returns a stale value immediately and refreshes in the background", async () => {
    invalidateCached();
    let calls = 0;
    const compute = async () => {
      calls++;
      if (calls > 1) await sleep(60);
      return calls;
    };
    assert.equal(await cachedSwr("stale", 10, 5000, compute), 1);
    await sleep(20); // past fresh, within stale
    const startedAt = Date.now();
    assert.equal(await cachedSwr("stale", 10, 5000, compute), 1, "old value comes back right away");
    assert.ok(Date.now() - startedAt < 40, "didn't wait for the slow refresh");
    await sleep(100);
    assert.equal(await cachedSwr("stale", 10_000, 20_000, compute), 2, "the background refresh landed");
  });

  it("keeps serving the old value when a background refresh fails", async () => {
    invalidateCached();
    let calls = 0;
    const compute = async () => {
      calls++;
      if (calls > 1) throw new Error("boom");
      return "good";
    };
    assert.equal(await cachedSwr("fails", 10, 5000, compute), "good");
    await sleep(20);
    assert.equal(await cachedSwr("fails", 10, 5000, compute), "good");
    await sleep(20);
    assert.equal(await cachedSwr("fails", 10, 5000, compute), "good");
  });

  it("waits for a fresh computation once the stale window has passed, and surfaces its error", async () => {
    invalidateCached();
    await cachedSwr("expired", 5, 10, async () => "old");
    await sleep(30);
    await assert.rejects(cachedSwr("expired", 5, 10, async () => Promise.reject(new Error("down"))), /down/);
  });
});
