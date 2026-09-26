import { test } from "node:test";
import assert from "node:assert/strict";
import { rolePanelsWizard } from "./rolePanels.js";
import type { AiWizardContext } from "../wizardKit.js";

const ctx: AiWizardContext = {
  guildName: "Test",
  voiceChannels: [],
  textChannels: [{ id: "100", name: "roles" }],
  categories: [],
  roles: [
    { id: "1", name: "Red" },
    { id: "2", name: "Blue" },
  ],
  emojis: [{ id: "555555555555555555", name: "redcircle", animated: false }],
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

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: null,
    enabled: null,
    trigger_type: "reaction",
    post_mode: "bot",
    channel_id: "100",
    existing_message_link: "",
    selection_mode: null,
    remove_on_unreact: null,
    content: null,
    embed: null,
    roles: [{ role_id: "1", emoji: "redcircle", label: null, style: null }],
    ...overrides,
  };
}

test("schema builds with $defs and strict objects everywhere", () => {
  const schema = rolePanelsWizard.buildResultSchema(ctx);
  assert.ok(schema.$defs && typeof schema.$defs === "object");
  assertStrict(schema);
});

test("resolves custom emoji names, drops unknown and duplicate roles, clamps labels", () => {
  const config = base({
    trigger_type: "button",
    roles: [
      { role_id: "1", emoji: ":redcircle:", label: "x".repeat(120), style: "danger" },
      { role_id: "1", emoji: "", label: null, style: null },
      { role_id: "999", emoji: "", label: null, style: null },
      { role_id: "2", emoji: "", label: null, style: "rainbow" },
    ],
  });
  assert.equal(rolePanelsWizard.validateConfig!(config, ctx), null);
  const roles = config.roles as Record<string, unknown>[];
  assert.equal(roles.length, 2);
  assert.equal(roles[0]!.emoji, "<:redcircle:555555555555555555>");
  assert.equal((roles[0]!.label as string).length, 80);
  assert.equal(roles[0]!.style, "danger");
  assert.equal(roles[1]!.style, null);
});

test("reaction panels need an emoji for every role", () => {
  const config = base({ roles: [{ role_id: "1", emoji: " ", label: null, style: null }] });
  assert.match(rolePanelsWizard.validateConfig!(config, ctx) ?? "", /emoji/);
});

test("bot mode needs a real channel, existing mode needs a message link", () => {
  assert.match(rolePanelsWizard.validateConfig!(base({ channel_id: "" }), ctx) ?? "", /channel/);
  assert.match(
    rolePanelsWizard.validateConfig!(base({ post_mode: "existing", channel_id: "", existing_message_link: "nope" }), ctx) ?? "",
    /link/,
  );
  const config = base({
    post_mode: "existing",
    channel_id: "",
    existing_message_link: " https://ptb.discord.com/channels/1/2/3 ",
  });
  assert.equal(rolePanelsWizard.validateConfig!(config, ctx), null);
  assert.equal(config.existing_message_link, "https://discord.com/channels/1/2/3");
});

test("embed is clamped and nulls stay null", () => {
  const config = base({ embed: { enabled: true, title: "t".repeat(300), color: 99999999, fields: null } });
  assert.equal(rolePanelsWizard.validateConfig!(config, ctx), null);
  const embed = config.embed as Record<string, unknown>;
  assert.equal((embed.title as string).length, 256);
  assert.equal(embed.color, 0xffffff);
  assert.equal(config.selection_mode, null);
  assert.equal(config.remove_on_unreact, null);
});

test("prompt never uses em dashes", () => {
  assert.ok(!rolePanelsWizard.buildSystemPrompt(ctx, 0).includes(String.fromCharCode(0x2014)));
});
