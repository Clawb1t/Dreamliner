import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPostUrls, mapPostView, normalizeActorInput, parseAtUri, parsePostUrl } from "./api.js";

test("parsePostUrl reads handle and DID post links", () => {
  assert.deepEqual(parsePostUrl("https://bsky.app/profile/alice.bsky.social/post/3kabc123"), {
    actor: "alice.bsky.social",
    rkey: "3kabc123",
  });
  assert.deepEqual(parsePostUrl("see https://bsky.app/profile/did:plc:abc123/post/3kxyz ok"), {
    actor: "did:plc:abc123",
    rkey: "3kxyz",
  });
  assert.equal(parsePostUrl("https://bsky.app/profile/alice.bsky.social"), null);
  assert.equal(parsePostUrl("https://example.com/profile/a/post/b"), null);
});

test("extractPostUrls finds every distinct link in order", () => {
  const text =
    "a https://bsky.app/profile/a.com/post/111 b https://bsky.app/profile/b.com/post/222 c https://bsky.app/profile/a.com/post/111";
  assert.deepEqual(extractPostUrls(text), [
    "https://bsky.app/profile/a.com/post/111",
    "https://bsky.app/profile/b.com/post/222",
  ]);
  // Regex state doesn't leak between calls.
  assert.ok(parsePostUrl("https://bsky.app/profile/a.com/post/111"));
  assert.equal(extractPostUrls("nothing here").length, 0);
});

test("normalizeActorInput accepts handles, @handles, profile links and DIDs", () => {
  assert.equal(normalizeActorInput("@Alice.bsky.social"), "alice.bsky.social");
  assert.equal(normalizeActorInput("alice"), "alice.bsky.social");
  assert.equal(normalizeActorInput("https://bsky.app/profile/news.example.com/"), "news.example.com");
  assert.equal(normalizeActorInput("did:plc:z72i7hdynmk6r22z27h6tvur"), "did:plc:z72i7hdynmk6r22z27h6tvur");
  assert.equal(normalizeActorInput("   "), null);
  assert.equal(normalizeActorInput("not a handle!"), null);
});

test("parseAtUri splits repo, collection and rkey", () => {
  assert.deepEqual(parseAtUri("at://did:plc:abc/app.bsky.feed.post/3k1"), {
    did: "did:plc:abc",
    collection: "app.bsky.feed.post",
    rkey: "3k1",
  });
  assert.equal(parseAtUri("https://bsky.app"), null);
});

test("mapPostView classifies replies/quotes and pulls media out of recordWithMedia", () => {
  const author = { did: "did:plc:a", handle: "a.test", displayName: "Alice", avatar: "https://cdn/a.jpg" };
  const quote = mapPostView({
    uri: "at://did:plc:a/app.bsky.feed.post/1",
    cid: "cid1",
    author,
    record: { text: "look", createdAt: "2026-01-01T00:00:00Z", embed: { $type: "app.bsky.embed.recordWithMedia" } },
    embed: {
      $type: "app.bsky.embed.recordWithMedia#view",
      media: { $type: "app.bsky.embed.images#view", images: [{ fullsize: "https://cdn/1.jpg", alt: "one" }] },
      record: {
        record: {
          $type: "app.bsky.embed.record#viewRecord",
          uri: "at://did:plc:b/app.bsky.feed.post/9",
          author: { did: "did:plc:b", handle: "b.test" },
          value: { text: "original" },
        },
      },
    },
  });
  assert.equal(quote.kind, "quote");
  assert.equal(quote.url, "https://bsky.app/profile/a.test/post/1");
  assert.deepEqual(quote.images, [{ url: "https://cdn/1.jpg", alt: "one" }]);
  assert.equal(quote.quoted?.text, "original");
  assert.equal(quote.quoted?.url, "https://bsky.app/profile/b.test/post/9");
  assert.equal(quote.quoted?.author.displayName, "b.test", "falls back to handle");

  const reply = mapPostView({
    uri: "at://did:plc:a/app.bsky.feed.post/2",
    cid: "cid2",
    author,
    record: { text: "hi", reply: { parent: { uri: "at://did:plc:c/app.bsky.feed.post/5" } } },
  });
  assert.equal(reply.kind, "reply");
  assert.equal(reply.replyParentUri, "at://did:plc:c/app.bsky.feed.post/5");
});
