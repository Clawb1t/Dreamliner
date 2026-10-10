import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { zSuggestionsConfig } from "../../../config/schemas/suggestions.js";
import { containerEdit } from "../../../core/responses.js";
import { buildSuggestionEmbed, feedActionRows } from "./embeds.js";
import type { Suggestion, SuggestionComment } from "./store.js";

const client = {
  user: { id: "1", username: "Dreamliner", displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png" },
} as unknown as Client;

function suggestion(content: string): Suggestion {
  return {
    id: 5,
    guildId: "1",
    suggestionNumber: 5,
    authorId: "2",
    content,
    anonymous: false,
    status: "approved",
    displayStatus: "open",
    createdAt: new Date(),
    denialReason: null,
    attachmentUrl: null,
  } as unknown as Suggestion;
}

function comment(id: number, content: string): SuggestionComment {
  return { id, suggestionId: 5, authorId: "300000000000000003", content, anonymous: false, createdAt: new Date() } as unknown as SuggestionComment;
}

/** Every TextDisplay's content in a top-level component tree. */
function textLength(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, n) => sum + textLength(n), 0);
  if (!node || typeof node !== "object") return 0;
  const record = (typeof (node as { toJSON?: unknown }).toJSON === "function"
    ? (node as { toJSON: () => unknown }).toJSON()
    : node) as Record<string, unknown>;
  const own = record.type === 10 && typeof record.content === "string" ? record.content.length : 0;
  return own + textLength(record.components ?? []);
}

test("a post with a long suggestion and many long comments stays inside Discord's 4000-char text limit", () => {
  const config = zSuggestionsConfig.parse({ public_votes: true });
  const comments = Array.from({ length: 20 }, (_, i) => comment(i + 1, `Comment ${i + 1} `.padEnd(1000, "x")));
  const embed = buildSuggestionEmbed({
    client,
    suggestion: suggestion("y".repeat(2000)),
    config,
    votes: { up: 3, mid: 0, down: 1, net: 2 },
    comments,
    commentCount: comments.length,
  });
  const payload = containerEdit(embed, feedActionRows(5, config, { up: 3, mid: 0, down: 1, net: 2 }));
  const length = textLength(payload.components);
  assert.ok(length <= 4000, `post text is ${length} characters`);
  // The newest comment is kept and the count still says all 20.
  const text = JSON.stringify(payload.components);
  assert.ok(text.includes("Comment #20"));
  assert.ok(!text.includes("Comment #1\\n") && !text.includes('"Comment #1"'));
  assert.ok(text.includes("**Comments**\\n20"));
});

test("short comments all show, oldest first", () => {
  const config = zSuggestionsConfig.parse({});
  const comments = [comment(1, "first"), comment(2, "second"), comment(3, "third")];
  const embed = buildSuggestionEmbed({ client, suggestion: suggestion("Add a music channel"), config, comments, commentCount: 3 });
  const text = JSON.stringify(containerEdit(embed, []).components);
  const first = text.indexOf("Comment #1");
  const third = text.indexOf("Comment #3");
  assert.ok(first > -1 && third > first);
});
