import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSpokenText } from "./sanitizeSpokenText.js";

describe("sanitizeSpokenText", () => {
  it("leaves ordinary text untouched", () => {
    assert.equal(sanitizeSpokenText("hey everyone, how's it going?"), "hey everyone, how's it going?");
  });

  it("strips a bare URL down to nothing", () => {
    assert.equal(sanitizeSpokenText("https://example.com/some/path?x=1"), "");
    assert.equal(sanitizeSpokenText("http://tenor.com/view/funny-cat-gif-123456"), "");
  });

  it("strips a URL embedded in a sentence, keeping the rest", () => {
    assert.equal(sanitizeSpokenText("check this out https://example.com/x lol"), "check this out lol");
  });

  it("strips a bare media filename", () => {
    assert.equal(sanitizeSpokenText("excited-cat.gif"), "");
    assert.equal(sanitizeSpokenText("look at this clip.mp4 right now"), "look at this right now");
  });

  it("does not touch ordinary words that just happen to end in extension-like letters", () => {
    assert.equal(sanitizeSpokenText("that mp4 format is old news"), "that mp4 format is old news");
  });

  it("collapses leftover whitespace after stripping", () => {
    assert.equal(sanitizeSpokenText("  hello   https://example.com   world  "), "hello world");
  });

  it("strips Discord custom emoji (static and animated)", () => {
    assert.equal(sanitizeSpokenText("<:blurplecheck:1533947878668763278>"), "");
    assert.equal(sanitizeSpokenText("nice <a:partyparrot:123456789012345678> work"), "nice work");
  });

  it("strips unicode emoji, including multi-codepoint ones", () => {
    assert.equal(sanitizeSpokenText("great job 🎉🎉🎉"), "great job");
    assert.equal(sanitizeSpokenText("👍 nice"), "nice");
    // Family emoji is a zero-width-joiner sequence of several pictographs — should fully disappear.
    assert.equal(sanitizeSpokenText("love this 👨‍👩‍👧‍👦"), "love this");
    // Flag emoji is a pair of regional indicator symbols.
    assert.equal(sanitizeSpokenText("🇬🇧 hello"), "hello");
  });

  it("leaves plain punctuation and non-emoji symbols alone", () => {
    assert.equal(sanitizeSpokenText("wait... really?! ok :)"), "wait... really?! ok :)");
  });
});
