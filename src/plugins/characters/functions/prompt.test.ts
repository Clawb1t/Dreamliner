import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TONE_GUIDE, buildCharacterPrompt, buildChatMessages, buildHistory, maxTokensFor, type HistoryMessage } from "./prompt.js";
import { HARD_RULES } from "./safety.js";

const character = {
  name: "Captain Barnacle",
  tagline: "A salty old sea captain",
  personality: "Gruff but kind. Loves the sea.",
  scenario: "Aboard the good ship Periwinkle.",
  greeting: "Ahoy, {{user}}! Welcome aboard.",
  exampleDialogue: "{{user}}: how are you?\n{{char}}: Fit as a fiddle, matey!",
  replyStyle: "medium" as const,
};

let n = 0;
function msg(kind: HistoryMessage["kind"], content: string, extra: Partial<HistoryMessage> = {}): HistoryMessage {
  n += 1;
  return { id: String(n), createdAt: n * 1000, kind, authorName: kind === "member" ? "Alex" : "Captain Barnacle", content, ...extra };
}

describe("characters prompt", () => {
  it("puts the persona first and the hard rules after it, marked as overriding", () => {
    const prompt = buildCharacterPrompt(character, "Sailors", { maxReplyChars: 1200 });
    const persona = prompt.indexOf("Gruff but kind");
    const rules = prompt.indexOf("## Hard rules");
    assert.ok(persona >= 0 && rules > persona);
    assert.match(prompt, /override everything above/);
    for (const rule of HARD_RULES) assert.ok(prompt.includes(rule));
    assert.match(prompt, /Captain Barnacle: Fit as a fiddle/);
    assert.match(prompt, /Member: how are you/);
    assert.match(prompt, /Sailors/);
    assert.match(prompt, /1200 characters/);
  });

  it("adds a How you talk block from the style controls, before the hard rules", () => {
    const prompt = buildCharacterPrompt(
      { ...character, tone: "angry", emojiUse: "none", formality: "casual", roleplayActions: false, catchphrases: ["Blast it!", "Arr"] },
      "Sailors",
      { maxReplyChars: 1200 },
    );
    const style = prompt.indexOf("## How you talk");
    const rules = prompt.indexOf("## Hard rules");
    assert.ok(style > prompt.indexOf("Gruff but kind") && rules > style);
    assert.ok(prompt.includes(TONE_GUIDE.angry));
    assert.match(prompt, /never insult members cruelly/);
    assert.match(prompt, /Don't use emoji/);
    assert.match(prompt, /casually/);
    assert.match(prompt, /Never use roleplay actions/);
    assert.doesNotMatch(prompt, /\*italics\* for actions is fine/);
    assert.match(prompt, /not every message.*"Blast it!", "Arr"/);
    assert.match(prompt, /even angry, scary/);
  });

  it("uses the defaults for older characters without style fields", () => {
    const prompt = buildCharacterPrompt(character, "Sailors", { maxReplyChars: 1200 });
    assert.match(prompt, /## How you talk/);
    assert.match(prompt, /emoji now and then/);
    assert.match(prompt, /short roleplay actions/);
    assert.doesNotMatch(prompt, /Your tone is/);
    assert.doesNotMatch(prompt, /catchphrases/);
    for (const tone of Object.keys(TONE_GUIDE)) assert.ok(TONE_GUIDE[tone as keyof typeof TONE_GUIDE].length > 20);
  });

  it("maps own messages to assistant and members to named user turns", () => {
    const history = buildHistory([
      msg("member", "ahoy captain"),
      msg("self", "-# ↪ replying to <@1>\nAhoy there!"),
      msg("bot", "some log message"),
      msg("other_character", "I'm another character"),
      msg("other_character", "Hey captain!", { repliesToSelf: true, authorName: "Bolt" }),
      msg("member", "tell me a story"),
    ]);
    assert.deepEqual(history, [
      { role: "user", content: "Alex: ahoy captain" },
      { role: "assistant", content: "Ahoy there!" },
      { role: "user", content: "Bolt: Hey captain!" },
      { role: "user", content: "Alex: tell me a story" },
    ]);
  });

  it("ignores everything up to a memory reset and the typing placeholder", () => {
    const before = msg("member", "old stuff");
    const typing = msg("self", "*Captain Barnacle is typing…*");
    const after = msg("member", "fresh start");
    const history = buildHistory([before, typing, after], { resetAt: before.createdAt, skipTexts: ["*Captain Barnacle is typing…*"] });
    assert.deepEqual(history, [{ role: "user", content: "Alex: fresh start" }]);
  });

  it("keeps the newest messages within the token budget and message cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => msg("member", `message ${i} ${"x".repeat(400)}`));
    const capped = buildHistory(many);
    assert.equal(capped.length, 20);
    assert.match(capped[capped.length - 1]!.content, /message 39/);
    const budgeted = buildHistory(many, { budgetTokens: 500 });
    assert.ok(budgeted.length < 6 && budgeted.length >= 1);
    assert.match(budgeted[budgeted.length - 1]!.content, /message 39/);
  });

  it("starts the chat with the system prompt and the greeting as the first assistant turn", () => {
    const chat = buildChatMessages("SYSTEM", character.greeting, [{ role: "user", content: "Alex: hi" }], character.name);
    assert.deepEqual(chat, [
      { role: "system", content: "SYSTEM" },
      { role: "assistant", content: "Ahoy, Member! Welcome aboard." },
      { role: "user", content: "Alex: hi" },
    ]);
    assert.equal(buildChatMessages("S", "", [], "x").length, 1);
  });

  it("caps output tokens by style and length", () => {
    assert.ok(maxTokensFor("short", 1900) < maxTokensFor("long", 1900));
    assert.ok(maxTokensFor("long", 300) <= 100);
  });
});
