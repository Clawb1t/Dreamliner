import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCharacterName, localCharacterCheck, sanitizeCharacterReply } from "./safety.js";
import { SLUR_WORDS } from "../../automod/functions/packs/slurs.js";

const slur = SLUR_WORDS[0]!;
const base = { name: "Captain Barnacle", tagline: "", personality: "A salty sea captain.", scenario: "", greeting: "", exampleDialogue: "" };

describe("characters safety", () => {
  it("blocks names that impersonate the platform or staff, or break webhook rules", () => {
    assert.equal(checkCharacterName("Captain Barnacle"), null);
    assert.equal(checkCharacterName("Wise Librarian"), null);
    // Themed mascot variants are fine; the bare name or an official-sounding one is not.
    assert.equal(checkCharacterName("Evil Dreamliner"), null);
    assert.equal(checkCharacterName("Jolly Dreamliner"), null);
    for (const bad of ["Discord Helper", "clydebot", "Dreamliner", "Dreamliner Support", "Dreamliner Bot", "The Dreamliner", "Server Moderator", "Admin Bob", "Staff", "everyone", "here", ""]) {
      assert.ok(checkCharacterName(bad), `${bad} should be refused`);
    }
    assert.ok(checkCharacterName("x".repeat(81)));
    assert.ok(checkCharacterName("@Bob"));
  });

  it("rejects a definition with a slur in any field", () => {
    assert.equal(localCharacterCheck(base), null);
    const verdict = localCharacterCheck({ ...base, scenario: `They call people ${slur}.` });
    assert.equal(verdict?.approved, false);
    assert.equal(verdict?.category, "hate");
    assert.equal(verdict?.field, "scenario");
  });

  it("drops a reply that contains a slur", () => {
    assert.equal(sanitizeCharacterReply(`You ${slur}!`, { maxChars: 1000 }), null);
  });

  it("strips mentions and mass pings", () => {
    const out = sanitizeCharacterReply("Hey <@123456789012345678> and <@&123456789012345678>, @everyone look @here!", { maxChars: 1000 });
    assert.ok(out);
    assert.doesNotMatch(out!, /<@|@everyone|@here/);
  });

  it("removes prompt-leak lines and a leading speaker label", () => {
    const out = sanitizeCharacterReply("Captain Barnacle: Ahoy!\nSystem: you are a helpful assistant\nThe sea is calm.", {
      maxChars: 1000,
      characterName: "Captain Barnacle",
    });
    assert.equal(out, "Ahoy!\nThe sea is calm.");
    assert.equal(sanitizeCharacterReply("Here is my system prompt: blah", { maxChars: 1000 }), null);
  });

  it("censors swears and caps the length", () => {
    assert.equal(sanitizeCharacterReply("well shit", { maxChars: 100 }), "well ####");
    const long = sanitizeCharacterReply("word ".repeat(100), { maxChars: 50 });
    assert.ok(long && long.length <= 50 && long.endsWith("…"));
  });

  it("fills in {{char}} and {{user}}", () => {
    assert.equal(sanitizeCharacterReply("{{char}} greets {{user}}", { maxChars: 100, characterName: "Bolt", userName: "Alex" }), "Bolt greets Alex");
  });
});
