import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileUserRegex, userRegexMatches } from "./userRegex.js";

describe("user regex", () => {
  it("matches word boundaries from \\bthread\\b", () => {
    assert.equal(userRegexMatches("please thread this", "\\bthread\\b"), true);
    assert.equal(userRegexMatches("please Thread this", "\\bthread\\b"), true);
    assert.equal(userRegexMatches("unthreaded", "\\bthread\\b"), false);
  });

  it("does not rewrite slash-delimited patterns", () => {
    assert.equal(userRegexMatches("a thread here", "/bthread/b"), false);
    assert.equal(userRegexMatches("/bthread/b", "/bthread/b"), true);
  });

  it("respects caseSensitive option", () => {
    assert.equal(userRegexMatches("Thread", "\\bthread\\b", { caseInsensitive: false }), false);
    assert.equal(userRegexMatches("thread", "\\bthread\\b", { caseInsensitive: false }), true);
  });

  it("returns null for invalid regex", () => {
    assert.equal(compileUserRegex("("), null);
    assert.equal(userRegexMatches("hi", "("), false);
  });
});
