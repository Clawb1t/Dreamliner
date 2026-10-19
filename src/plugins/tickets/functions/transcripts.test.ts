import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTranscriptParticipant,
  mapTranscriptComponents,
  mapTranscriptEmbed,
  mapTranscriptMessage,
  parseTranscriptPayload,
  type TranscriptSourceMessage,
} from "./transcripts.js";

function fakeMessage(overrides: Partial<TranscriptSourceMessage> = {}): TranscriptSourceMessage {
  return {
    id: "100",
    content: "hello **there**",
    createdAt: new Date("2026-01-01T10:00:00.000Z"),
    editedAt: null,
    author: {
      id: "42",
      tag: "pilot",
      username: "pilot",
      globalName: "Pilot Pete",
      bot: false,
      displayAvatarURL: () => "https://cdn.discordapp.com/avatars/42/a.png?size=64",
    },
    member: null,
    attachments: new Map([
      ["1", { name: "shot.png", url: "https://cdn.discordapp.com/attachments/1/shot.png", contentType: "image/png", size: 1234, width: 800, height: 600 }],
    ]),
    embeds: [],
    components: [],
    ...overrides,
  };
}

test("mapTranscriptMessage keeps the old fields and adds the author snapshot", () => {
  const mapped = mapTranscriptMessage(fakeMessage());
  assert.equal(mapped.id, "100");
  assert.equal(mapped.authorId, "42");
  assert.equal(mapped.authorTag, "pilot");
  assert.equal(mapped.authorName, "Pilot Pete");
  assert.equal(mapped.authorAvatar, "https://cdn.discordapp.com/avatars/42/a.png?size=64");
  assert.equal(mapped.authorBot, false);
  assert.equal(mapped.content, "hello **there**");
  assert.equal(mapped.createdAt, "2026-01-01T10:00:00.000Z");
  assert.deepEqual(mapped.attachments, [
    { name: "shot.png", url: "https://cdn.discordapp.com/attachments/1/shot.png", contentType: "image/png", size: 1234, width: 800, height: 600 },
  ]);
  assert.equal(mapped.embeds, undefined);
  assert.equal(mapped.components, undefined);
});

test("mapTranscriptMessage prefers the member's server nickname and avatar", () => {
  const mapped = mapTranscriptMessage(
    fakeMessage({ member: { displayName: "Captain", displayAvatarURL: () => "https://cdn.discordapp.com/guilds/1/users/42/avatars/b.png" } }),
  );
  assert.equal(mapped.authorName, "Captain");
  assert.equal(mapped.authorAvatar, "https://cdn.discordapp.com/guilds/1/users/42/avatars/b.png");
});

test("mapTranscriptEmbed captures every visible part and drops unsafe urls", () => {
  const embed = mapTranscriptEmbed({
    title: "Ticket #4",
    description: "Thanks <@42>",
    url: "javascript:alert(1)",
    color: 0x5662f5,
    timestamp: "2026-01-01T10:00:00.000Z",
    author: { name: "Dreamliner", icon_url: "https://cdn.discordapp.com/x.png" },
    fields: [
      { name: "Opened by", value: "<@42>", inline: true },
      { name: "", value: "" },
    ],
    footer: { text: "Footer", icon_url: "data:image/png;base64,AAA" },
    image: { url: "https://cdn.discordapp.com/big.png" },
    thumbnail: { url: "https://cdn.discordapp.com/small.png" },
  });
  assert.deepEqual(embed, {
    title: "Ticket #4",
    description: "Thanks <@42>",
    color: 0x5662f5,
    timestamp: "2026-01-01T10:00:00.000Z",
    author: { name: "Dreamliner", iconUrl: "https://cdn.discordapp.com/x.png" },
    fields: [{ name: "Opened by", value: "<@42>", inline: true }],
    footer: { text: "Footer" },
    imageUrl: "https://cdn.discordapp.com/big.png",
    thumbnailUrl: "https://cdn.discordapp.com/small.png",
  });
  assert.equal(mapTranscriptEmbed({ type: "rich" }), null);
  assert.equal(mapTranscriptEmbed(null), null);
});

test("mapTranscriptComponents flattens Components V2 containers into text, images and buttons", () => {
  const blocks = mapTranscriptComponents([
    {
      type: 17,
      accent_color: 0xff0000,
      components: [
        { type: 10, content: "**Ticket #4**" },
        {
          type: 9,
          components: [{ type: 10, content: "Welcome!" }],
          accessory: { type: 11, media: { url: "https://cdn.discordapp.com/icon.png" } },
        },
        { type: 14, divider: true },
        { type: 12, items: [{ media: { url: "https://cdn.discordapp.com/g1.png" } }] },
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "Close", custom_id: "close" },
            { type: 2, style: 5, label: "Docs", url: "https://dreamliner.site/docs" },
          ],
        },
      ],
    },
    { type: 10, content: "loose text" },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.accentColor, 0xff0000);
  assert.deepEqual(blocks[0]!.items, [
    { type: "text", content: "**Ticket #4**" },
    { type: "text", content: "Welcome!" },
    { type: "image", url: "https://cdn.discordapp.com/icon.png" },
    { type: "separator" },
    { type: "image", url: "https://cdn.discordapp.com/g1.png" },
    { type: "buttons", buttons: [{ label: "Close" }, { label: "Docs", url: "https://dreamliner.site/docs" }] },
  ]);
  assert.deepEqual(blocks[1], { accentColor: null, items: [{ type: "text", content: "loose text" }] });
});

test("mapTranscriptMessage reads embeds and components through toJSON", () => {
  const mapped = mapTranscriptMessage(
    fakeMessage({
      content: "",
      embeds: [{ toJSON: () => ({ title: "Hi" }) }],
      components: [{ toJSON: () => ({ type: 17, components: [{ type: 10, content: "V2 body" }] }) }, { toJSON: () => { throw new Error("bad"); } }],
    }),
  );
  assert.deepEqual(mapped.embeds, [{ title: "Hi" }]);
  assert.deepEqual(mapped.components, [{ accentColor: null, items: [{ type: "text", content: "V2 body" }] }]);
});

test("parseTranscriptPayload reads old bare arrays and new versioned payloads", () => {
  const old = parseTranscriptPayload(JSON.stringify([{ id: "1", authorId: "2", authorTag: "a", content: "x", createdAt: "", attachments: [] }]));
  assert.equal(old.channelName, null);
  assert.equal(old.messages.length, 1);
  const next = parseTranscriptPayload(JSON.stringify({ v: 2, channelName: "ticket-0004", messages: [] }));
  assert.equal(next.channelName, "ticket-0004");
  assert.deepEqual(next.messages, []);
  assert.deepEqual(parseTranscriptPayload("not json"), { channelName: null, messages: [] });
});

test("isTranscriptParticipant: opener, added members, claimer, and message authors only", () => {
  const ticket = { openerId: "1", memberIds: ["2"], claimedBy: "3" };
  const messages = [{ authorId: "4" }];
  assert.equal(isTranscriptParticipant("1", ticket, messages), true);
  assert.equal(isTranscriptParticipant("2", ticket, messages), true);
  assert.equal(isTranscriptParticipant("3", ticket, messages), true);
  assert.equal(isTranscriptParticipant("4", ticket, messages), true);
  assert.equal(isTranscriptParticipant("5", ticket, messages), false);
  assert.equal(isTranscriptParticipant("", { openerId: "", memberIds: [], claimedBy: null }, []), false);
});
