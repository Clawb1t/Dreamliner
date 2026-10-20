import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDraftMessages, generateCharacterDraft, parseCharacterDraft, parseDraftRequest } from "./draft.js";
import { SLUR_WORDS } from "../../automod/functions/packs/slurs.js";

const slur = SLUR_WORDS[0]!;
const good = {
  name: "Old Bramble",
  tone: "grumpy",
  emojiUse: "none",
  formality: "casual",
  roleplayActions: true,
  tagline: "A lighthouse keeper with a secret love of poetry",
  personality: "Bramble has kept the lighthouse for forty years. ".repeat(10),
  scenario: "A windswept lighthouse on a rocky island.",
  greeting: "*squints* Another visitor, {{user}}? Mind the stairs.",
  exampleDialogue: "User: hi\nOld Bramble: Hmph. Hello.\n{{user}}: do you like poems?\n**Old Bramble**: ...Maybe.",
  catchphrases: ["Mind the stairs.", "Hmph.", "Blast it!", "Oh shit", "Hmph."],
};

describe("characters autopilot draft", () => {
  it("validates the request", () => {
    assert.equal(parseDraftRequest({}).ok, false);
    assert.equal(parseDraftRequest({ description: "x".repeat(501) }).ok, false);
    assert.equal(parseDraftRequest({ description: "a pirate", tone: "nope" }).ok, false);
    assert.equal(parseDraftRequest({ description: "a pirate", name: "Discord Pirate" }).ok, false);
    const ok = parseDraftRequest({ description: " a grumpy old lighthouse keeper ", name: "", tone: "" });
    assert.deepEqual(ok, { ok: true, value: { description: "a grumpy old lighthouse keeper", name: undefined, tone: undefined } });
    const withAll = parseDraftRequest({ description: "a pirate", name: "Captain  Barnacle", tone: "dramatic" });
    assert.ok(withAll.ok && withAll.value.name === "Captain Barnacle" && withAll.value.tone === "dramatic");
  });

  it("asks for JSON with the hard rules and the given name/tone", () => {
    const messages = buildDraftMessages({ description: "a pirate", name: "Barnacle", tone: "dramatic" });
    const all = messages.map((m) => m.content).join("\n");
    assert.match(all, /Fill in every field/);
    assert.match(all, /No sexual or NSFW content/);
    assert.match(all, /Name \(use exactly this\): Barnacle/);
    assert.match(all, /Tone \(use exactly this\): dramatic/);
  });

  it("trims and validates the model's draft", () => {
    const draft = parseCharacterDraft(good, { description: "x" })!;
    assert.equal(draft.name, "Old Bramble");
    assert.equal(draft.tone, "grumpy");
    assert.equal(draft.emojiUse, "none");
    assert.equal(draft.formality, "casual");
    assert.ok(draft.personality.length <= 3000);
    assert.deepEqual(draft.catchphrases, ["Mind the stairs.", "Hmph.", "Blast it!"]);
    assert.equal(draft.exampleDialogue, "{{user}}: hi\n{{char}}: Hmph. Hello.\n{{user}}: do you like poems?\n{{char}}: ...Maybe.");
  });

  it("keeps the manager's name and tone, falls back on bad values", () => {
    const draft = parseCharacterDraft(
      { ...good, name: "Discord Mod", tone: "furious", emojiUse: "tons", formality: 3, roleplayActions: "yes", tagline: "x".repeat(300) },
      { description: "x" },
    )!;
    assert.equal(draft.name, "");
    assert.equal(draft.tone, "warm");
    assert.equal(draft.emojiUse, "some");
    assert.equal(draft.formality, "balanced");
    assert.equal(draft.roleplayActions, true);
    assert.ok(draft.tagline.length <= 120);
    const given = parseCharacterDraft(good, { description: "x", name: "Barnacle", tone: "calm" })!;
    assert.equal(given.name, "Barnacle");
    assert.equal(given.tone, "calm");
  });

  it("refuses unusable or hateful drafts", () => {
    assert.equal(parseCharacterDraft(null, { description: "x" }), null);
    assert.equal(parseCharacterDraft({ ...good, personality: "" }, { description: "x" }), null);
    assert.equal(parseCharacterDraft({ ...good, scenario: `full of ${slur}` }, { description: "x" }), null);
  });

  it("generates through the (mocked) Autopilot call with a strict schema", async () => {
    let schema: Record<string, unknown> = {};
    const draft = await generateCharacterDraft(
      { description: "a lighthouse keeper" },
      {
        call: async (input) => {
          schema = input.schema;
          return good;
        },
      },
    );
    assert.equal(draft.name, "Old Bramble");
    assert.equal(schema.additionalProperties, false);
    assert.equal((schema.required as string[]).length, Object.keys(schema.properties as object).length);
    await assert.rejects(generateCharacterDraft({ description: "x" }, { call: async () => ({}) }));
  });
});
