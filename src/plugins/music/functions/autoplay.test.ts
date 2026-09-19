import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Track } from "lavalink-client";
import { pickAutoplayCandidate } from "./autoplay.js";

function track(identifier: string, title = identifier, author = "Someone"): Track {
  return { info: { identifier, title, author } } as Track;
}

describe("pickAutoplayCandidate", () => {
  it("only ever returns a candidate that isn't excluded by id", () => {
    const candidates = [track("a"), track("b"), track("c")];
    for (let i = 0; i < 20; i++) {
      const pick = pickAutoplayCandidate(candidates, ["a"]);
      assert.notEqual(pick?.info.identifier, "a");
      assert.ok(["b", "c"].includes(pick!.info.identifier));
    }
  });

  it("skips every excluded identifier, not just the first", () => {
    const candidates = [track("a"), track("b"), track("c")];
    const pick = pickAutoplayCandidate(candidates, ["a", "b"]);
    assert.equal(pick?.info.identifier, "c");
  });

  it("returns null when every candidate is excluded by id", () => {
    const candidates = [track("a"), track("b")];
    const pick = pickAutoplayCandidate(candidates, ["a", "b"]);
    assert.equal(pick, null);
  });

  it("returns null for an empty candidate list", () => {
    assert.equal(pickAutoplayCandidate([], []), null);
  });

  it("returns null for an empty exclusion list with no candidates", () => {
    assert.equal(pickAutoplayCandidate([], ["a"]), null);
  });

  it("picks the only candidate when nothing is excluded", () => {
    const candidates = [track("a")];
    assert.equal(pickAutoplayCandidate(candidates, [])?.info.identifier, "a");
  });

  it("excludes a candidate whose song-key (normalized title+author) matches, even with a different id", () => {
    const reupload = track("different-id", "Song Title (Official Video)", "Cool Artist");
    const candidates = [reupload];
    const pick = pickAutoplayCandidate(candidates, [], ["cool artist::song title"]);
    assert.equal(pick, null);
  });

  it("does not exclude a candidate whose song-key doesn't match", () => {
    const candidates = [track("x", "A Totally Different Song", "Cool Artist")];
    const pick = pickAutoplayCandidate(candidates, [], ["cool artist::song title"]);
    assert.equal(pick?.info.identifier, "x");
  });

  it("varies its pick across calls when multiple valid candidates exist", () => {
    const candidates = [track("a"), track("b"), track("c"), track("d"), track("e")];
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const pick = pickAutoplayCandidate(candidates, []);
      if (pick) seen.add(pick.info.identifier);
    }
    assert.ok(seen.size > 1, "expected pickAutoplayCandidate to return more than one distinct track across repeated calls");
  });
});
