import { test } from "node:test";
import assert from "node:assert/strict";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import { parseKitDocument, type KitDocument } from "./document.js";
import { KitRenderError, renderKit, renderText, timeVars, type RenderContext } from "./render.js";

const ASSET = "0123456789abcdef";

function doc(input: unknown): KitDocument {
  const result = parseKitDocument(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
}

const ctx = (extra: Partial<RenderContext> = {}): RenderContext => ({
  kitId: 7,
  vars: { server: "Plane Spotters", member_count: "1234", date: "<t:1:D>" },
  plainVars: { server: "Plane Spotters", member_count: "1234", date: "1 January 1970" },
  assetFile: (id) => (id === ASSET ? "banner.png" : null),
  now: new Date("2026-11-03T12:00:00Z"),
  ...extra,
});

test("placeholders render, unknown ones stay as written", () => {
  assert.equal(renderText("{server} has {member_count} members, {nope}", { server: "S", member_count: "3" }), "S has 3 members, {nope}");
  const vars = timeVars(new Date("2026-11-03T09:05:00Z"));
  assert.equal(vars.markdown.date, `<t:${Date.parse("2026-11-03T09:05:00Z") / 1000}:D>`);
  assert.equal(vars.plain.date, "3 November 2026");
  assert.equal(vars.plain.time, "09:05 UTC");
});

test("classic: content, embeds, rows and flags", () => {
  const rendered = renderKit(
    doc({
      content: "Hi {server}",
      embeds: [
        {
          title: "{date}",
          description: "Since {date}",
          color: 0x112233,
          author: { name: "Staff", icon_url: `asset:${ASSET}` },
          footer: { text: "" , icon_url: "https://example.com/f.png" },
          timestamp: "now",
          fields: [{ name: "Members", value: "{member_count}", inline: true }],
        },
      ],
      rows: [
        {
          type: "buttons",
          buttons: [
            { id: "rules", label: "Rules", style: "success", action: { type: "kit", kit_id: 2 } },
            { id: "site", label: "Site", style: "link", url: "https://example.com", emoji: "<:plane:123456789012345678>" },
          ],
        },
        { type: "select", select: { id: "pick", placeholder: "Pick", options: [{ id: "a", label: "A", emoji: "✈️" }] } },
      ],
      mentions: { users: true, roles: true, everyone: false },
      flags: { silent: true },
    }),
    ctx(),
  );
  assert.equal(rendered.format, "classic");
  assert.equal(rendered.body.content, "Hi Plane Spotters");
  const embed = rendered.body.embeds![0]!;
  assert.equal(embed.title, "1 January 1970", "titles use plain placeholder values");
  assert.equal(embed.description, "Since <t:1:D>");
  assert.equal(embed.author?.icon_url, "attachment://banner.png");
  assert.equal(embed.footer, undefined, "footer icons need footer text");
  assert.equal(embed.timestamp, "2026-11-03T12:00:00.000Z");
  assert.deepEqual(embed.fields, [{ name: "Members", value: "1234", inline: true }]);
  assert.deepEqual(rendered.assetIds, [ASSET]);
  const [buttons, menu] = rendered.body.components!;
  assert.equal(buttons!.type, ComponentType.ActionRow);
  const [rules, site] = (buttons as { components: Record<string, unknown>[] }).components;
  assert.deepEqual(rules, { type: ComponentType.Button, disabled: false, label: "Rules", style: ButtonStyle.Success, custom_id: "mk:7:rules" });
  assert.deepEqual(site, {
    type: ComponentType.Button,
    disabled: false,
    label: "Site",
    emoji: { id: "123456789012345678", name: "plane" },
    style: ButtonStyle.Link,
    url: "https://example.com",
  });
  const select = (menu as { components: Record<string, unknown>[] }).components[0]!;
  assert.equal(select.custom_id, "mk:7:pick");
  assert.deepEqual(select.options, [{ label: "A", value: "a", emoji: { name: "✈️" } }]);
  assert.equal(rendered.body.flags, MessageFlags.SuppressNotifications);
  assert.deepEqual(rendered.body.allowedMentions, { parse: ["users", "roles"] });
});

test("V2: blocks become components with the V2 flag", () => {
  const rendered = renderKit(
    doc({
      format: "v2",
      blocks: [
        {
          type: "container",
          accent_color: 0xabcdef,
          children: [
            { type: "text", content: "# {server}" },
            { type: "section", texts: ["Hello"], accessory: { type: "thumbnail", url: `asset:${ASSET}` } },
            { type: "separator", spacing: "large" },
            { type: "gallery", items: [{ url: "https://example.com/1.png", description: "One" }] },
            { type: "row", row: { type: "buttons", buttons: [{ id: "go", label: "Go" }] } },
          ],
        },
        { type: "file", asset_id: ASSET, spoiler: true },
      ],
    }),
    ctx(),
  );
  assert.equal(rendered.format, "v2");
  assert.equal(rendered.body.flags, MessageFlags.IsComponentsV2);
  assert.equal(rendered.body.content, undefined);
  assert.equal(rendered.body.embeds, undefined);
  const [container, file] = rendered.body.components as Record<string, unknown>[];
  assert.equal(container!.type, ComponentType.Container);
  assert.equal(container!.accent_color, 0xabcdef);
  const children = container!.components as Record<string, unknown>[];
  assert.deepEqual(children[0], { type: ComponentType.TextDisplay, content: "# Plane Spotters" });
  assert.deepEqual((children[1]!.accessory as Record<string, unknown>).media, { url: "attachment://banner.png" });
  assert.equal(children[2]!.spacing, 2);
  assert.deepEqual(children[3]!.items, [{ media: { url: "https://example.com/1.png" }, spoiler: false, description: "One" }]);
  assert.equal(((children[4]!.components as Record<string, unknown>[])[0]!).custom_id, "mk:7:go");
  assert.deepEqual(file, { type: ComponentType.File, file: { url: "attachment://banner.png" }, spoiler: true });
  assert.deepEqual(rendered.assetIds, [ASSET], "each asset is attached once");
});

test("render errors explain what to fix", () => {
  const missing = doc({ embeds: [{ title: "t", image_url: "asset:ffffffffffffffff" }] });
  assert.throws(() => renderKit(missing, ctx()), (error: unknown) => error instanceof KitRenderError && error.path === "embeds[0].image_url");
  const long = doc({ content: "{big}" });
  assert.throws(
    () => renderKit(long, ctx({ vars: { big: "x".repeat(2001) } })),
    (error: unknown) => error instanceof KitRenderError && /2001/.test(error.message) && error.path === "content",
  );
  const empty = doc({ content: "{blank}" });
  assert.throws(() => renderKit(empty, ctx({ vars: { blank: "" } })), KitRenderError);
});

test("suppress link previews only applies without embeds", () => {
  const rendered = renderKit(doc({ content: "https://example.com", flags: { suppress_embeds: true } }), ctx());
  assert.equal(rendered.body.flags, MessageFlags.SuppressEmbeds);
});
