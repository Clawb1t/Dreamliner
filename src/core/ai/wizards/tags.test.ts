import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTagName, tagsWizard } from "./tags.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [],
  categories: [],
  roles: [],
  emojis: [],
};

/** Every object in a strict-mode schema must list all its keys as required and forbid extras. */
function assertStrict(node: unknown, path = "root"): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${path}[${i}]`));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === "object" || (Array.isArray(o.type) && o.type.includes("object"))) {
    assert.equal(o.additionalProperties, false, `${path} allows extra properties`);
    assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties as object).sort(), `${path} required`);
  }
  for (const [k, v] of Object.entries(o)) assertStrict(v, `${path}.${k}`);
}

test("schema builds with $defs and strict objects everywhere", () => {
  const schema = tagsWizard.buildResultSchema(ctx);
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  assertStrict(schema);
});

test("tag names follow the bridge rules", () => {
  assert.equal(normalizeTagName("FAQ Payment!"), "faq-payment");
  assert.equal(normalizeTagName("/rules"), "rules");
  assert.equal(normalizeTagName("__hidden"), "hidden");
  assert.equal(normalizeTagName("!!!"), "");
  assert.equal(normalizeTagName("a".repeat(80)).length, 64);
  assert.equal(normalizeTagName("-x"), "x");
});

test("keeps several tags, drops blanks and duplicates, clamps content", () => {
  const config: Record<string, unknown> = {
    tags: [
      { name: "Rules", content: "Be nice." },
      { name: "rules", content: "Duplicate" },
      { name: "", content: "No name" },
      { name: "empty", content: "   " },
      { name: "long", content: "x".repeat(2500) },
    ],
  };
  assert.equal(tagsWizard.validateConfig!(config, ctx), null);
  const tags = config.tags as { name: string; content: string }[];
  assert.deepEqual(
    tags.map((t) => t.name),
    ["rules", "long"],
  );
  assert.equal(tags[1]!.content.length, 2000);
});

test("errors when nothing usable is left", () => {
  assert.ok(tagsWizard.validateConfig!({ tags: [{ name: "?", content: "" }] }, ctx));
});

test("prompt never uses em dashes", () => {
  assert.ok(!tagsWizard.buildSystemPrompt(ctx, 0).includes(String.fromCharCode(0x2014)));
});
