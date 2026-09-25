import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlueskyFeedOptions } from "../../../config/schemas/bluesky.js";
import { buildSubscribeUrl, classifyCommit, passesKindFilter, recordHasMedia, type StreamCommit } from "./stream.js";

function commit(overrides: Partial<StreamCommit>): StreamCommit {
  return {
    did: "did:plc:a",
    seq: 1,
    time: "2026-01-01T00:00:00Z",
    operation: "create",
    collection: "app.bsky.feed.post",
    rkey: "3k",
    record: { text: "hello" },
    ...overrides,
  };
}

test("classifyCommit tells posts, replies, quotes and reposts apart", () => {
  assert.equal(classifyCommit(commit({})), "post");
  assert.equal(classifyCommit(commit({ record: { reply: { parent: {} } } })), "reply");
  assert.equal(classifyCommit(commit({ record: { embed: { $type: "app.bsky.embed.record" } } })), "quote");
  assert.equal(classifyCommit(commit({ record: { embed: { $type: "app.bsky.embed.recordWithMedia" } } })), "quote");
  assert.equal(
    classifyCommit(commit({ collection: "app.bsky.feed.repost", record: { subject: { uri: "at://x/app.bsky.feed.post/1" } } })),
    "repost",
  );
  assert.equal(classifyCommit(commit({ operation: "delete", record: undefined })), null);
  assert.equal(classifyCommit(commit({ collection: "app.bsky.feed.like" })), null);
});

test("recordHasMedia sees images and video, including beside a quote", () => {
  assert.equal(recordHasMedia(commit({ record: { embed: { $type: "app.bsky.embed.images" } } })), true);
  assert.equal(recordHasMedia(commit({ record: { embed: { $type: "app.bsky.embed.video" } } })), true);
  assert.equal(
    recordHasMedia(commit({ record: { embed: { $type: "app.bsky.embed.recordWithMedia", media: { $type: "app.bsky.embed.images" } } } })),
    true,
  );
  assert.equal(recordHasMedia(commit({ record: { embed: { $type: "app.bsky.embed.external" } } })), false);
  assert.equal(recordHasMedia(commit({})), false);
});

test("passesKindFilter follows the feed's toggles (defaults: no replies)", () => {
  const defaults = validateBlueskyFeedOptions({});
  assert.equal(passesKindFilter("post", defaults), true);
  assert.equal(passesKindFilter("reply", defaults), false);
  assert.equal(passesKindFilter("repost", defaults), true);
  assert.equal(passesKindFilter("quote", defaults), true);
  const strict = validateBlueskyFeedOptions({ include_reposts: false, include_quotes: false, include_replies: true });
  assert.equal(passesKindFilter("repost", strict), false);
  assert.equal(passesKindFilter("quote", strict), false);
  assert.equal(passesKindFilter("reply", strict), true);
});

test("buildSubscribeUrl repeats collections and dids and adds the cursor", () => {
  const url = new URL(buildSubscribeUrl("jetstream.example", ["did:plc:a", "did:plc:b"], 42));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/xrpc/network.bsky.jetstream.subscribeEvents");
  assert.deepEqual(url.searchParams.getAll("collections"), ["app.bsky.feed.post", "app.bsky.feed.repost"]);
  assert.deepEqual(url.searchParams.getAll("dids"), ["did:plc:a", "did:plc:b"]);
  assert.equal(url.searchParams.get("cursor"), "42");
  assert.equal(new URL(buildSubscribeUrl("h", [], null)).searchParams.has("cursor"), false);
});
