import { test } from "node:test";
import assert from "node:assert/strict";
import { GuildQueue } from "./queue.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test("jobs for one guild run one at a time, in order", async () => {
  const queue = new GuildQueue();
  const order: string[] = [];
  let running = 0;
  const job = (name: string) => async () => {
    running += 1;
    assert.equal(running, 1);
    order.push(`start ${name}`);
    await tick();
    order.push(`end ${name}`);
    running -= 1;
  };
  await Promise.all([queue.run("g", job("a")), queue.run("g", job("b")), queue.run("g", job("c"))]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("different guilds don't wait for each other", async () => {
  const queue = new GuildQueue();
  const order: string[] = [];
  const slow = queue.run("g1", async () => {
    await tick(20);
    order.push("g1");
  });
  const fast = queue.run("g2", async () => {
    order.push("g2");
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["g2", "g1"]);
});

test("each job is told how many are queued behind it", async () => {
  const queue = new GuildQueue();
  const behind: number[] = [];
  await Promise.all([0, 1, 2, 3].map(() => queue.run("g", async (n) => void behind.push(n))));
  assert.deepEqual(behind, [3, 2, 1, 0]);
});

test("a failing job doesn't stop the queue, and empty guilds are removed", async () => {
  const queue = new GuildQueue();
  const failed = queue.run("g", async () => {
    throw new Error("boom");
  });
  const next = queue.run("g", async () => "ok");
  await assert.rejects(failed);
  assert.equal(await next, "ok");
  await tick();
  assert.equal(queue.size, 0);
  assert.equal(queue.depth("g"), 0);
});
