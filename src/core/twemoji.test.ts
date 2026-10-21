import { test } from "node:test";
import assert from "node:assert/strict";
import { hasTwemoji, twemojiCode, twemojiImage } from "./twemoji.js";

test("Twemoji file names follow Twemoji's rules", () => {
  assert.equal(twemojiCode("🌙"), "1f319");
  // The variation selector is dropped for a single emoji...
  assert.equal(twemojiCode("✈️"), "2708");
  // ...but kept inside zero-width-joiner sequences.
  assert.equal(twemojiCode("🏳️‍🌈"), "1f3f3-fe0f-200d-1f308");
  assert.equal(twemojiCode("👍🏽"), "1f44d-1f3fd");
});

test("every name icon the store sells has Twemoji artwork", () => {
  for (const emoji of ["✈️", "🌙", "⭐", "🔥", "💎", "👑", "🎃", "👻", "🏳️‍🌈", "👍🏽"]) {
    assert.ok(hasTwemoji(emoji), `${emoji} has no Twemoji file`);
  }
  assert.equal(hasTwemoji("not an emoji"), false);
  assert.equal(hasTwemoji(""), false);
});

test("icons rasterise at the requested size (crisp, not a 36px bitmap scaled up)", () => {
  const small = twemojiImage("👑", 18);
  const large = twemojiImage("👑", 72);
  assert.ok(small && large);
  assert.equal(small.width, 18);
  assert.equal(large.width, 72);
  assert.equal(twemojiImage("nope", 32), null);
});
