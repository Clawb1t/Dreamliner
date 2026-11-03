import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countV2Components,
  defaultKitDocument,
  emptyEmbed,
  formatIssuePath,
  kitPreview,
  listAssetRefs,
  messageAssetIds,
  parseKitDocument,
  parseKitDraft,
  referencedAssetIds,
  v2TextLength,
  type KitBlock,
} from "./document.js";

const issuesOf = (input: unknown) => {
  const result = parseKitDocument(input);
  return result.ok ? [] : result.issues;
};
const paths = (input: unknown) => issuesOf(input).map((issue) => issue.path);

const button = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, style: "primary", ...extra });

test("issue paths are formatted like embeds[0].fields[2].value", () => {
  assert.equal(formatIssuePath(["embeds", 0, "fields", 2, "value"]), "embeds[0].fields[2].value");
  assert.equal(formatIssuePath([]), "");
  assert.equal(formatIssuePath(["blocks", 3]), "blocks[3]");
});

test("defaults fill a minimal classic document", () => {
  const result = parseKitDocument({ content: "Hello" });
  assert.ok(result.ok);
  assert.equal(result.document.format, "classic");
  assert.deepEqual(result.document.mentions, { users: true, roles: false, everyone: false });
  assert.equal(result.document.identity.mode, "bot");
  assert.equal(defaultKitDocument("v2").format, "v2");
});

test("empty classic messages and empty embeds are rejected", () => {
  assert.deepEqual(paths({ content: "" }), ["content"]);
  assert.deepEqual(paths({ embeds: [{}] }), ["embeds[0]"]);
  assert.ok(parseKitDocument({ embeds: [{ image_url: "https://example.com/a.png" }] }).ok);
});

test("embed field limits point at the exact field", () => {
  const fields = [
    { name: "a", value: "b" },
    { name: "c", value: "d" },
    { name: "e", value: "x".repeat(1025) },
  ];
  assert.deepEqual(paths({ embeds: [{ title: "t", fields }] }), ["embeds[0].fields[2].value"]);
  assert.deepEqual(paths({ embeds: [{ title: "t", fields: [{ name: "", value: "v" }] }] }), ["embeds[0].fields[0].name"]);
  assert.deepEqual(paths({ embeds: [{ title: "x".repeat(257) }] }), ["embeds[0].title"]);
});

test("embeds share a 6000 character budget", () => {
  const big = { ...emptyEmbed(), description: "x".repeat(4000) };
  const issues = issuesOf({ embeds: [big, big] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.path, "embeds");
  assert.match(issues[0]!.message, /8000/);
});

test("content is capped at 2000 and images must be links or assets", () => {
  assert.deepEqual(paths({ content: "x".repeat(2001) }), ["content"]);
  assert.deepEqual(paths({ embeds: [{ title: "t", image_url: "ftp://nope" }] }), ["embeds[0].image_url"]);
  assert.ok(parseKitDocument({ embeds: [{ title: "t", image_url: "asset:0123456789abcdef" }] }).ok);
  assert.ok(parseKitDocument({ embeds: [{ title: "t", thumbnail_url: "{guild_icon_url}" }] }).ok);
});

test("rows: five buttons, one select, link buttons need links, ids are unique", () => {
  const six = Array.from({ length: 6 }, (_, i) => button(`b${i}`));
  assert.deepEqual(paths({ content: "x", rows: [{ type: "buttons", buttons: six }] }), ["rows[0].buttons"]);
  assert.deepEqual(paths({ content: "x", rows: [{ type: "buttons", buttons: [button("go", { style: "link", url: "" })] }] }), [
    "rows[0].buttons[0].url",
  ]);
  assert.deepEqual(
    paths({ content: "x", rows: [{ type: "buttons", buttons: [button("same")] }, { type: "buttons", buttons: [button("same")] }] }),
    ["rows[1].buttons[0].id"],
  );
  assert.deepEqual(paths({ content: "x", rows: [{ type: "buttons", buttons: [button("Bad Id")] }] }), ["rows[0].buttons[0].id"]);
  assert.deepEqual(paths({ content: "x", rows: [{ type: "buttons", buttons: [{ id: "x", label: "", style: "primary" }] }] }), [
    "rows[0].buttons[0].label",
  ]);
  const rows = Array.from({ length: 6 }, (_, i) => ({ type: "buttons", buttons: [button(`r${i}`)] }));
  assert.deepEqual(paths({ content: "x", rows }), ["rows"]);
});

test("selects: option counts and multi-choice actions", () => {
  const options = [
    { id: "a", label: "A", action: { type: "role", role_ids: ["123456789012345678"] } },
    { id: "b", label: "B", action: { type: "kit", kit_id: 4 } },
  ];
  const select = { id: "pick", options, max_values: 2, min_values: 1 };
  assert.deepEqual(paths({ content: "x", rows: [{ type: "select", select }] }), ["rows[0].select.options[1].action"]);
  assert.deepEqual(paths({ content: "x", rows: [{ type: "select", select: { ...select, max_values: 3, options: [options[0]] } }] }), [
    "rows[0].select.max_values",
  ]);
  assert.ok(parseKitDocument({ content: "x", rows: [{ type: "select", select: { id: "pick", options } }] }).ok);
});

test("actions: role limits and form fields", () => {
  const roles = Array.from({ length: 11 }, (_, i) => `1234567890123456${String(i).padStart(2, "0")}`);
  assert.deepEqual(paths({ content: "x", rows: [{ type: "buttons", buttons: [button("r", { action: { type: "role", role_ids: roles } })] }] }), [
    "rows[0].buttons[0].action.role_ids",
  ]);
  const form = {
    type: "form",
    title: "Apply",
    channel_id: "123456789012345678",
    fields: [
      { id: "q", label: "Why?", min: 10, max: 5 },
      { id: "q", label: "Again" },
    ],
  };
  assert.deepEqual(paths({ content: "x", rows: [{ type: "buttons", buttons: [button("f", { action: form })] }] }).sort(), [
    "rows[0].buttons[0].action.fields[0].min",
    "rows[0].buttons[0].action.fields[1].id",
  ]);
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, label: "Q" }));
  assert.deepEqual(paths({ content: "x", rows: [{ type: "buttons", buttons: [button("f", { action: { ...form, fields: six } })] }] }), [
    "rows[0].buttons[0].action.fields",
  ]);
});

test("V2: component counting includes nested components", () => {
  const blocks: KitBlock[] = [
    { type: "text", content: "hi" },
    {
      type: "container",
      accent_color: null,
      spoiler: false,
      children: [
        { type: "text", content: "a" },
        {
          type: "section",
          texts: ["one", "two"],
          accessory: { type: "thumbnail", url: "https://x.y/z.png", description: "", spoiler: false },
        },
        { type: "row", row: { type: "buttons", buttons: [] } },
        { type: "separator", divider: true, spacing: "small" },
      ],
    },
  ];
  // text 1 + container (1 + text 1 + section 4 + row 1 + separator 1)
  assert.equal(countV2Components(blocks), 9);
  assert.equal(v2TextLength(blocks), "hi".length + "a".length + "one".length + "two".length);
});

test("V2: 40 components, 4000 characters, no nested containers, gallery sizes", () => {
  const texts = Array.from({ length: 41 }, () => ({ type: "text", content: "x" }));
  assert.deepEqual(paths({ format: "v2", blocks: texts }), ["blocks"]);
  const overCount = Array.from({ length: 20 }, () => ({
    type: "container",
    children: [{ type: "text", content: "x" }],
  }));
  const tooMany = issuesOf({ format: "v2", blocks: [...overCount, { type: "text", content: "y" }] });
  assert.equal(tooMany[0]!.path, "blocks");
  assert.match(tooMany[0]!.message, /41/);
  const long = Array.from({ length: 2 }, () => ({ type: "text", content: "x".repeat(2001) }));
  assert.match(issuesOf({ format: "v2", blocks: long })[0]!.message, /4000/);
  const nested = issuesOf({ format: "v2", blocks: [{ type: "container", children: [{ type: "container", children: [] }] }] });
  assert.equal(nested[0]!.path, "blocks[0].children[0].type");
  assert.deepEqual(paths({ format: "v2", blocks: [{ type: "gallery", items: [] }] }), ["blocks[0].items"]);
  assert.deepEqual(paths({ format: "v2", blocks: [] }), ["blocks"]);
  assert.deepEqual(paths({ format: "v2", blocks: [{ type: "section", texts: ["a", "b", "c", "d"], accessory: { type: "button", button: button("b") } }] }), [
    "blocks[0].texts",
  ]);
});

test("V2 ignores classic fields, and webhook names can't contain Discord", () => {
  assert.ok(parseKitDocument({ format: "v2", content: "", blocks: [{ type: "text", content: "hi" }] }).ok);
  assert.deepEqual(paths({ content: "x", identity: { mode: "webhook", name: "Discord News" } }), ["identity.name"]);
  assert.deepEqual(paths({ embeds: [{ title: "t" }], flags: { suppress_embeds: true } }), ["flags.suppress_embeds"]);
});

test("asset helpers find every reference", () => {
  const a = "0123456789abcdef";
  const b = "fedcba9876543210";
  const doc = parseKitDocument({
    embeds: [{ title: "t", image_url: `asset:${a}` }],
    attachments: [b, a],
    blocks: [{ type: "file", asset_id: "1111111111111111" }],
    identity: { mode: "webhook", avatar_url: "asset:2222222222222222" },
  });
  assert.ok(doc.ok);
  assert.deepEqual(messageAssetIds(doc.document), [a, b]);
  assert.deepEqual(referencedAssetIds(doc.document).sort(), [a, b, "1111111111111111", "2222222222222222"].sort());
  assert.deepEqual(
    listAssetRefs(doc.document).map((ref) => [formatIssuePath(ref.path), ref.image]),
    [
      ["embeds[0].image_url", true],
      ["attachments[0]", false],
      ["attachments[1]", false],
      ["identity.avatar_url", true],
    ],
  );
});

test("previews pick a title and snippet", () => {
  const classic = parseKitDocument({ content: "Welcome   to\nthe server", embeds: [{ title: "Rules", color: 0xff0000 }] });
  assert.ok(classic.ok);
  assert.deepEqual(kitPreview(classic.document), { title: "Rules", snippet: "Welcome to the server", color: 0xff0000 });
  const v2 = parseKitDocument({ format: "v2", blocks: [{ type: "container", accent_color: 5, children: [{ type: "text", content: "## Hello\nWorld" }] }] });
  assert.ok(v2.ok);
  assert.deepEqual(kitPreview(v2.document), { title: "Hello", snippet: "World", color: 5 });
});

test("blank and half-built kits save as drafts but can't be sent", () => {
  // A brand-new blank kit, in either format.
  assert.ok(parseKitDraft(defaultKitDocument("classic")).ok);
  assert.ok(parseKitDraft(defaultKitDocument("v2")).ok);
  assert.ok(!parseKitDocument(defaultKitDocument("classic")).ok);
  assert.ok(!parseKitDocument(defaultKitDocument("v2")).ok);

  // Pieces still being filled in: an empty embed, an unlabelled button, a form with no channel,
  // an empty text block and a file block waiting for its upload.
  const halfBuilt = {
    embeds: [{}],
    rows: [{ type: "buttons", buttons: [{ id: "b1", label: "", style: "link", url: "" }] }, { type: "buttons", buttons: [] }],
  };
  assert.ok(parseKitDraft(halfBuilt).ok);
  assert.ok(!parseKitDocument(halfBuilt).ok);
  const form = { content: "x", rows: [{ type: "buttons", buttons: [button("f", { action: { type: "form" } })] }] };
  assert.ok(parseKitDraft(form).ok);
  assert.ok(!parseKitDocument(form).ok);
  const v2 = { format: "v2", blocks: [{ type: "text", content: "" }, { type: "file", asset_id: "" }, { type: "container", children: [] }] };
  assert.ok(parseKitDraft(v2).ok);
  assert.ok(!parseKitDocument(v2).ok);

  // Drafts still enforce Discord's limits and link/id formats.
  assert.ok(!parseKitDraft({ content: "x".repeat(2001) }).ok);
  assert.ok(!parseKitDraft({ embeds: [{ url: "javascript:alert(1)" }] }).ok);
  assert.ok(!parseKitDraft({ rows: [{ type: "buttons", buttons: [{ id: "b", label: "Go", style: "link", url: "ftp://x" }] }] }).ok);
  assert.ok(!parseKitDraft({ format: "v2", blocks: [{ type: "file", asset_id: "../../etc" }] }).ok);

  // The draft flag never leaks: a strict parse right after a draft one is still strict.
  assert.ok(!parseKitDocument({}).ok);
});
