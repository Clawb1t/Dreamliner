import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEmojiByName } from "./emoji.js";

const EMOJIS = [
  { id: "111", name: "blahaj", animated: false },
  { id: "222", name: "PartyBlob", animated: true },
];

describe("resolveEmojiByName", () => {
  it("resolves a bare name to the matching custom emoji mention", () => {
    assert.equal(resolveEmojiByName("blahaj", EMOJIS), "<:blahaj:111>");
  });

  it("matches case-insensitively", () => {
    assert.equal(resolveEmojiByName("BLAHAJ", EMOJIS), "<:blahaj:111>");
  });

  it("uses the animated form for an animated emoji", () => {
    assert.equal(resolveEmojiByName("partyblob", EMOJIS), "<a:PartyBlob:222>");
  });

  it("strips surrounding colons before matching", () => {
    assert.equal(resolveEmojiByName(":blahaj:", EMOJIS), "<:blahaj:111>");
  });

  it("leaves a literal Unicode emoji unchanged when no custom emoji matches", () => {
    assert.equal(resolveEmojiByName("⭐", EMOJIS), "⭐");
  });

  it("leaves unmatched free text unchanged", () => {
    assert.equal(resolveEmojiByName("nonexistent", EMOJIS), "nonexistent");
  });

  it("leaves an already-formed mention unchanged", () => {
    assert.equal(resolveEmojiByName("<:other:999>", EMOJIS), "<:other:999>");
  });

  it("leaves a bare snowflake id unchanged", () => {
    assert.equal(resolveEmojiByName("123456789012345678", EMOJIS), "123456789012345678");
  });

  it("leaves empty input unchanged", () => {
    assert.equal(resolveEmojiByName("", EMOJIS), "");
    assert.equal(resolveEmojiByName("   ", EMOJIS), "");
  });
});
