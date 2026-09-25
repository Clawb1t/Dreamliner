import { test } from "node:test";
import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import type { BlueskyPost } from "./api.js";
import { buildPostCard, cardMedia, MAX_CARD_IMAGES } from "./card.js";
import { buildTopMessage } from "./notify.js";
import { parseBlueskyCustomId } from "../constants.js";

const author = { did: "did:plc:a", handle: "a.test", displayName: "Alice", avatarUrl: "https://cdn/a.jpg", url: "https://bsky.app/profile/a.test" };

function post(overrides: Partial<BlueskyPost> = {}): BlueskyPost {
  return {
    uri: "at://did:plc:a/app.bsky.feed.post/1",
    cid: "cid",
    url: "https://bsky.app/profile/a.test/post/1",
    author,
    text: "Hello Bluesky",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    kind: "post",
    replyParentUri: null,
    images: [],
    videoThumbnailUrl: null,
    external: null,
    quoted: null,
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
    quoteCount: 0,
    ...overrides,
  };
}

test("post card: avatar section, accent, media gallery capped at four, buttons inside", () => {
  const images = Array.from({ length: 6 }, (_, i) => ({ url: `https://cdn/${i}.jpg`, alt: "" }));
  const { container, row } = buildPostCard(post({ images }), { accentColor: 0x1185fe, showMedia: true, deliveryId: 7 });
  const data = container.toContainerComponent([row.toJSON()]);

  assert.equal(data.accentColor, 0x1185fe);
  const [section, gallery, actions] = data.components as unknown as Array<Record<string, unknown>>;
  assert.equal(section!.type, ComponentType.Section);
  assert.match(JSON.stringify(section), /Hello Bluesky/);
  assert.match(JSON.stringify(section), /@a\.test/);
  assert.equal(gallery!.type, ComponentType.MediaGallery);
  assert.equal((gallery!.items as unknown[]).length, MAX_CARD_IMAGES);
  assert.equal(actions!.type, ComponentType.ActionRow);

  const buttons = (actions!.components as Array<{ custom_id?: string; url?: string }>);
  assert.deepEqual(parseBlueskyCustomId(buttons[0]!.custom_id!), { kind: "like", deliveryId: 7 });
  assert.deepEqual(parseBlueskyCustomId(buttons[1]!.custom_id!), { kind: "repost", deliveryId: 7 });
  assert.equal(buttons[2]!.url, "https://bsky.app/profile/a.test/post/1");
});

test("post card without a delivery only links out, and hides media when asked", () => {
  const { container, row } = buildPostCard(post({ videoThumbnailUrl: "https://cdn/v.jpg" }), {
    accentColor: 1,
    showMedia: false,
    deliveryId: null,
  });
  const data = container.toContainerComponent([row.toJSON()]);
  assert.ok(!data.components.some((c) => c.type === ComponentType.MediaGallery));
  assert.equal(row.components.length, 1);
});

test("cardMedia prefers photos, then video thumbnail, then link preview", () => {
  assert.deepEqual(cardMedia(post({ videoThumbnailUrl: "v" })), ["v"]);
  assert.deepEqual(cardMedia(post({ external: { url: "u", title: "t", description: "", thumbUrl: "x" } })), ["x"]);
  assert.deepEqual(cardMedia(post()), []);
});

test("repost and reply context lines", () => {
  const reposter = { ...author, handle: "r.test", displayName: "Rae", url: "https://bsky.app/profile/r.test" };
  const reposted = JSON.stringify(buildPostCard(post(), { accentColor: 1, showMedia: true, deliveryId: 1, repostedBy: reposter }).container.toContainerComponent());
  assert.match(reposted, /Reposted by \[Rae\]/);
  const reply = JSON.stringify(
    buildPostCard(post({ kind: "reply" }), { accentColor: 1, showMedia: true, deliveryId: 1, replyToHandle: "b.test" }).container.toContainerComponent(),
  );
  assert.match(reply, /Replying to @b\.test/);
});

test("buildTopMessage fills tokens and places role pings", () => {
  assert.equal(buildTopMessage("{creator_name} posted", [], { creator_name: "Alice" }), "Alice posted");
  assert.equal(buildTopMessage("{creator_name} posted", ["1", "2"], { creator_name: "Alice" }), "<@&1> <@&2> Alice posted");
  assert.equal(buildTopMessage("Hey {roles}!", ["1"], {}), "Hey <@&1>!");
  assert.equal(buildTopMessage("", ["1"], {}), "<@&1>");
  assert.equal(buildTopMessage("", [], {}), "");
});
