import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultKitDocument, parseKitDocument } from "./document.js";
import { documentFromMessageData, importKitJson, KitImportError } from "./importers.js";

test("classic messages keep content, embeds and link buttons", () => {
  const { document, warnings } = documentFromMessageData({
    content: "Hello",
    flags: 4096,
    embeds: [
      {
        type: "rich",
        title: "Rules",
        description: "Be nice",
        color: 0x5865f2,
        fields: [{ name: "1", value: "No spam", inline: false }, { name: "", value: "dropped" }],
        footer: { text: "Mods", icon_url: "https://example.com/i.png" },
        image: { url: "https://cdn.discordapp.com/attachments/1/2/a.png" },
        timestamp: "2026-11-01T10:00:00+00:00",
      },
      { type: "article", title: "Preview" },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Site", url: "https://example.com", emoji: { id: "123456789012345678", name: "plane", animated: true } },
          { type: 2, style: 1, label: "Verify", custom_id: "other-bot" },
        ],
      },
      { type: 1, components: [{ type: 3, custom_id: "menu", options: [] }] },
    ],
  });
  assert.equal(document.format, "classic");
  assert.equal(document.content, "Hello");
  assert.equal(document.flags.silent, true);
  assert.equal(document.embeds.length, 1);
  assert.equal(document.embeds[0]!.fields.length, 1);
  assert.equal(document.embeds[0]!.timestamp, "2026-11-01T10:00:00.000Z");
  assert.equal(document.rows.length, 1);
  const link = document.rows[0]!.type === "buttons" ? document.rows[0]!.buttons[0]! : null;
  assert.equal(link?.style, "link");
  assert.equal(link?.emoji, "<a:plane:123456789012345678>");
  assert.ok(warnings.some((w) => /can't be imported/.test(w)));
  assert.ok(warnings.some((w) => /expire/.test(w)));
  assert.ok(warnings.some((w) => /Link previews/.test(w)));
  assert.ok(parseKitDocument(document).ok);
});

test("Components V2 messages become blocks", () => {
  const { document, warnings } = documentFromMessageData({
    flags: 32768,
    components: [
      {
        type: 17,
        accent_color: 0xff0000,
        components: [
          { type: 10, content: "# Title" },
          { type: 9, components: [{ type: 10, content: "Side" }], accessory: { type: 11, media: { url: "https://example.com/t.png" } } },
          { type: 9, components: [{ type: 10, content: "Clicky" }], accessory: { type: 2, style: 1, custom_id: "x", label: "X" } },
          { type: 14, divider: false, spacing: 2 },
          { type: 12, items: [{ media: { url: "https://example.com/g.png" }, description: "G" }] },
          { type: 13, file: { url: "attachment://a.pdf" } },
        ],
      },
    ],
  });
  assert.equal(document.format, "v2");
  const container = document.blocks[0]!;
  assert.equal(container.type, "container");
  if (container.type !== "container") return;
  assert.equal(container.accent_color, 0xff0000);
  assert.deepEqual(
    container.children.map((child) => child.type),
    ["text", "section", "text", "separator", "gallery"],
  );
  assert.ok(warnings.some((w) => /Files/.test(w)));
  assert.ok(parseKitDocument(document).ok);
});

test("JSON: Discohook backups, Embed Generator, embed lists and native kits", () => {
  const backup = importKitJson(
    JSON.stringify({ version: "d2", messages: [{ data: { content: "First", username: "Bot News" } }, { data: { content: "Second" } }] }),
  );
  assert.equal(backup.document.content, "First");
  assert.equal(backup.document.identity.mode, "webhook");
  assert.equal(backup.document.identity.name, "Bot News");
  assert.match(backup.warnings[0]!, /first of 2/);

  const generator = importKitJson(JSON.stringify({ content: "", embeds: [{ title: "Hi", color: 255 }], components: [] }));
  assert.equal(generator.document.embeds[0]!.title, "Hi");
  assert.equal(generator.warnings.length, 0);

  const list = importKitJson(JSON.stringify([{ description: "One" }, { description: "Two" }]));
  assert.equal(list.document.embeds.length, 2);

  const single = importKitJson(JSON.stringify({ title: "Only embed" }));
  assert.equal(single.document.embeds[0]!.title, "Only embed");

  const native = importKitJson(JSON.stringify({ document: { ...defaultKitDocument("v2"), blocks: [{ type: "text", content: "Hi" }] } }));
  assert.equal(native.document.format, "v2");
  assert.equal(native.warnings.length, 0);
});

test("JSON errors are clear, and leftovers become fix-before-saving warnings", () => {
  assert.throws(() => importKitJson("{nope"), KitImportError);
  assert.throws(() => importKitJson(JSON.stringify({ hello: 1 })), KitImportError);
  assert.throws(() => importKitJson("42"), KitImportError);
  const empty = importKitJson(JSON.stringify({ content: "" }));
  assert.ok(empty.warnings.some((w) => /Fix before saving \(content\)/.test(w)));
});

test("imports never switch on @everyone pings or keep non-web link buttons", () => {
  const message = importKitJson(
    JSON.stringify({
      content: "Hello @everyone",
      allowed_mentions: { parse: ["everyone", "roles"] },
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 5, label: "Bad", url: "javascript:alert(1)" },
            { type: 2, style: 5, label: "Data", url: "data:text/html,<script>alert(1)</script>" },
            { type: 2, style: 5, label: "Good", url: "https://example.com" },
          ],
        },
      ],
    }),
  );
  assert.equal(message.document.mentions.everyone, false);
  assert.equal(message.document.mentions.roles, true);
  assert.ok(message.warnings.some((w) => /@everyone/.test(w)));
  const row = message.document.rows[0]!;
  assert.equal(row.type, "buttons");
  assert.deepEqual(
    row.type === "buttons" ? row.buttons.map((b) => b.url) : [],
    ["https://example.com"],
  );

  const native = importKitJson(JSON.stringify({ ...defaultKitDocument(), content: "Hi", mentions: { users: true, roles: false, everyone: true } }));
  assert.equal(native.document.mentions.everyone, false);
  assert.ok(native.warnings.some((w) => /@everyone/.test(w)));
});
