import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPostUrls, mapPostView, normalizeActorInput, parseAtUri, parseCollectionUrl, parsePostUrl } from "./api.js";

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
  assert.deepEqual(quote.images, [{ url: "https://cdn/1.jpg", alt: "one", thumbUrl: "https://cdn/1.jpg" }]);
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

test("parseCollectionUrl reads list and starter pack links", () => {
  assert.deepEqual(parseCollectionUrl("https://bsky.app/profile/alice.bsky.social/lists/3kabcxyz"), {
    kind: "list",
    actor: "alice.bsky.social",
    rkey: "3kabcxyz",
  });
  assert.deepEqual(parseCollectionUrl("bsky.app/profile/did:plc:abc123/lists/3kl?ref=x"), {
    kind: "list",
    actor: "did:plc:abc123",
    rkey: "3kl",
  });
  assert.deepEqual(parseCollectionUrl("https://bsky.app/starter-pack/bob.com/3jpack"), {
    kind: "starter_pack",
    actor: "bob.com",
    rkey: "3jpack",
  });
  assert.deepEqual(parseCollectionUrl("https://www.bsky.app/start/did:plc:xyz/3jpack/"), {
    kind: "starter_pack",
    actor: "did:plc:xyz",
    rkey: "3jpack",
  });
  assert.deepEqual(parseCollectionUrl("https://go.bsky.app/AbC123"), { kind: "short_link", code: "AbC123" });
  assert.deepEqual(parseCollectionUrl("at://did:plc:abc/app.bsky.graph.list/3kl"), {
    kind: "list",
    actor: "did:plc:abc",
    rkey: "3kl",
  });
  assert.deepEqual(parseCollectionUrl("at://did:plc:abc/app.bsky.graph.starterpack/3sp"), {
    kind: "starter_pack",
    actor: "did:plc:abc",
    rkey: "3sp",
  });
});

test("parseCollectionUrl rejects profiles, posts and other sites", () => {
  assert.equal(parseCollectionUrl(""), null);
  assert.equal(parseCollectionUrl("https://bsky.app/profile/alice.bsky.social"), null);
  assert.equal(parseCollectionUrl("https://bsky.app/profile/alice.bsky.social/post/3k"), null);
  assert.equal(parseCollectionUrl("https://bsky.app/profile/alice.bsky.social/lists"), null);
  assert.equal(parseCollectionUrl("https://example.com/profile/a/lists/b"), null);
  assert.equal(parseCollectionUrl("https://bsky.app.evil.com/starter-pack/a/b"), null);
  assert.equal(parseCollectionUrl("https://go.bsky.app/a/b"), null);
  assert.equal(parseCollectionUrl("at://did:plc:abc/app.bsky.feed.post/3k"), null);
  assert.equal(parseCollectionUrl("not a link"), null);
});
