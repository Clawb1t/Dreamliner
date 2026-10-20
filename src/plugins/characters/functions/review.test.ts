import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReviewUnavailableError, parseReviewVerdict, reviewCharacter } from "./safety.js";

const def = { name: "Captain Barnacle", tagline: "A sea captain", personality: "Gruff but kind.", scenario: "", greeting: "Ahoy!", exampleDialogue: "" };

describe("characters review", () => {
  it("parses approvals and rejections", () => {
    assert.deepEqual(parseReviewVerdict({ approved: true, reason: "", category: "" }), { approved: true, reason: null, category: null });
    assert.deepEqual(parseReviewVerdict({ approved: false, reason: "This is a real celebrity.", category: "real_person" }), {
      approved: false,
      reason: "This is a real celebrity.",
      category: "real_person",
    });
    assert.deepEqual(parseReviewVerdict({ approved: "no", category: "weird" }), {
      approved: false,
      reason: "This character doesn't follow the character rules.",
      category: "other",
    });
    assert.equal(parseReviewVerdict({ reason: "x" }), null);
    assert.equal(parseReviewVerdict("approved"), null);
    assert.equal(parseReviewVerdict(null), null);
  });

  it("uses the mocked DeepSeek verdict", async () => {
    let prompt = "";
    const verdict = await reviewCharacter(def, {
      configured: true,
      call: async ({ messages }) => {
        prompt = messages.map((m) => m.content).join("\n");
        return { value: { approved: false, reason: "Sexual content isn't allowed.", category: "sexual" } };
      },
    });
    assert.equal(verdict.approved, false);
    assert.equal(verdict.category, "sexual");
    assert.equal(verdict.aiReviewed, true);
    assert.match(prompt, /Captain Barnacle/);
    assert.match(prompt, /JSON/);
  });

  it("runs the local check before calling the model", async () => {
    let called = false;
    const verdict = await reviewCharacter({ ...def, name: "Discord Staff" }, {
      configured: true,
      call: async () => {
        called = true;
        return { value: { approved: true } };
      },
    });
    assert.equal(called, false);
    assert.equal(verdict.approved, false);
    assert.equal(verdict.field, "name");
  });

  it("approves on the local check alone when DeepSeek isn't configured", async () => {
    const verdict = await reviewCharacter(def, { configured: false });
    assert.equal(verdict.approved, true);
    assert.equal(verdict.aiReviewed, false);
  });

  it("sends the tone and catchphrases to the review", async () => {
    let prompt = "";
    await reviewCharacter({ ...def, tone: "scary", catchphrases: ["Boo!"] }, {
      configured: true,
      call: async ({ messages }) => {
        prompt = messages.map((m) => m.content).join("\n");
        return { value: { approved: true } };
      },
    });
    assert.match(prompt, /Tone preset: scary/);
    assert.match(prompt, /Catchphrases: "Boo!"/);
  });

  it("throws ReviewUnavailableError on an unreadable verdict or API error", async () => {
    await assert.rejects(reviewCharacter(def, { configured: true, call: async () => ({ value: { nope: 1 } }) }), ReviewUnavailableError);
    await assert.rejects(
      reviewCharacter(def, {
        configured: true,
        call: async () => {
          throw new Error("429");
        },
      }),
      ReviewUnavailableError,
    );
  });
});
