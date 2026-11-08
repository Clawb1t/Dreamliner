import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAnswers } from "./answers.js";
import { TEMPLATE_SCHEMA, buildPrompt, directionsFor } from "./generate.js";
import { channel, snapshot } from "./testSupport.js";

/** OpenAI strict mode: every object lists all its properties as required and forbids extras. */
function assertStrict(schema: unknown, path = "$"): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;
  if (s.type === "object" || (Array.isArray(s.type) && s.type.includes("object"))) {
    const props = Object.keys((s.properties as Record<string, unknown>) ?? {});
    assert.deepEqual([...((s.required as string[]) ?? [])].sort(), props.sort(), `${path} requires every property`);
    assert.equal(s.additionalProperties, false, `${path} forbids extra properties`);
  }
  for (const [key, value] of Object.entries(s)) {
    if (Array.isArray(value)) value.forEach((v, i) => assertStrict(v, `${path}.${key}[${i}]`));
    else if (value && typeof value === "object") assertStrict(value, `${path}.${key}`);
  }
}

describe("generation", () => {
  it("uses a strict-mode JSON schema", () => {
    assertStrict(TEMPLATE_SCHEMA);
  });

  it("offers three distinct directions", () => {
    const dirs = directionsFor(parseAnswers({ audience: { size: "huge" } }));
    assert.deepEqual(dirs.map((d) => d.id), ["a", "b", "c"]);
    assert.equal(new Set(dirs.map((d) => d.brief)).size, 3);
  });

  it("puts the answers, language, existing server and naming into the prompt", () => {
    const answers = parseAnswers({
      basics: { server_name: "Pixel Party", type: "gaming", language: "German" },
      naming: { preset: "emoji_bar", channel_pattern: "{emoji}｜{name}", emoji_mode: "all" },
      existing: { mode: "merge" },
    });
    const snap = snapshot({ channels: [channel("📜｜regeln", "text"), channel("💬｜allgemein", "text")] });
    const { system, user } = buildPrompt(answers, snap, directionsFor(answers)[1]!);
    assert.match(user, /Pixel Party/);
    assert.match(user, /Language: German/);
    assert.match(user, /regeln/);
    assert.match(user, /MERGE/);
    assert.match(system, /DIRECTION B/);
    assert.match(system, /💬｜general-chat/);
    assert.match(system, /set `naming` to null/);
    assert.doesNotMatch(system, /—/, "no em dashes in the prompt");
  });

  it("lets the AI pick naming only when asked", () => {
    const answers = parseAnswers({ naming: { preset: "auto" } });
    const { system } = buildPrompt(answers, snapshot(), directionsFor(answers)[0]!);
    assert.match(system, /let Autopilot pick the naming style/);
  });
});
