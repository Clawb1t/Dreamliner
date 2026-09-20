import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryAsync } from "./retry.js";

describe("retryAsync", () => {
  it("returns the result on the first try without retrying", async () => {
    let calls = 0;
    const result = await retryAsync(async () => {
      calls++;
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries after a failure and returns the eventual success", async () => {
    let calls = 0;
    const result = await retryAsync(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { attempts: 5, delayMs: 1 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("returns null once every attempt fails, without throwing", async () => {
    let calls = 0;
    const result = await retryAsync(
      async () => {
        calls++;
        throw new Error("always fails");
      },
      { attempts: 3, delayMs: 1 },
    );
    assert.equal(result, null);
    assert.equal(calls, 3);
  });

  it("calls onError once per failed attempt with the right attempt number", async () => {
    const seenAttempts: number[] = [];
    await retryAsync(
      async () => {
        throw new Error("nope");
      },
      {
        attempts: 3,
        delayMs: 1,
        onError: (_error, attempt) => seenAttempts.push(attempt),
      },
    );
    assert.deepEqual(seenAttempts, [1, 2, 3]);
  });
});
