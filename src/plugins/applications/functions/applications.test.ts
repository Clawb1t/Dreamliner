import { test } from "node:test";
import { ComponentType } from "discord.js";
import assert from "node:assert/strict";
import { paginateQuestions } from "../../../core/formModal.js";
import { zApplicationsConfig } from "../../../config/schemas/applications.js";
import {
  applicationAcceptId,
  applicationApplyId,
  applicationContinueId,
  applicationDenyModalId,
  applicationModalId,
  parseApplicationCustomId,
} from "../constants.js";
import { buildDecisionDm, buildReviewButtons, buildReviewEmbed, buildVerdictContainer } from "./review.js";
import type { ApplicationRecord } from "./store.js";

const OPENING = "0b6f7a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";

test("custom IDs round-trip and stay within Discord's 100-char limit", () => {
  const ids = [
    [applicationApplyId(OPENING), { kind: "apply", openingId: OPENING }],
    [applicationContinueId(OPENING, 2), { kind: "next", openingId: OPENING, page: 2 }],
    [applicationModalId(OPENING, 3), { kind: "modal", openingId: OPENING, page: 3 }],
    [applicationAcceptId(42), { kind: "accept", applicationId: 42 }],
    [applicationDenyModalId(7), { kind: "denymodal", applicationId: 7 }],
  ] as const;
  for (const [id, expected] of ids) {
    assert.ok(id.length <= 100);
    assert.deepEqual(parseApplicationCustomId(id), expected);
  }
  assert.equal(parseApplicationCustomId("dl:ticket:open:x"), null);
  assert.equal(parseApplicationCustomId("dl:app:apply:not-a-uuid"), null);
});

test("forms split into pages of five", () => {
  const pages = paginateQuestions(Array.from({ length: 12 }, (_, i) => i));
  assert.deepEqual(pages.map((p) => p.length), [5, 5, 2]);
  assert.deepEqual(paginateQuestions([]), []);
});

test("config defaults parse, and a 20-question opening is accepted", () => {
  const questions = Array.from({ length: 20 }, (_, i) => ({
    id: `0b6f7a1e-2c3d-4e5f-8a9b-${String(i).padStart(12, "0")}`,
    label: `Question ${i + 1}`,
  }));
  const parsed = zApplicationsConfig.safeParse({ openings: [{ id: OPENING, name: "Moderator", questions }] });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.openings[0]!.button.label, "Apply");
});

function record(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: 1,
    guildId: "1",
    openingId: OPENING,
    openingName: "Moderator",
    userId: "123",
    status: "pending",
    answers: [],
    reviewChannelId: null,
    reviewMessageId: null,
    threadId: null,
    reviewerId: null,
    reason: null,
    createdAt: new Date(0),
    decidedAt: null,
    ...overrides,
  };
}

/** Every TextDisplay's content in a Components V2 tree. */
function allText(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as { type?: number; content?: unknown; components?: unknown[] };
  const own = n.type === ComponentType.TextDisplay && typeof n.content === "string" ? [n.content] : [];
  return [...own, ...(n.components ?? []).flatMap(allText)];
}

test("review embed stays under Discord's 6000 character limit with 20 long answers", () => {
  const answers = Array.from({ length: 20 }, (_, i) => ({
    questionId: String(i),
    label: `Why do you want to be a moderator, question ${i + 1}?`,
    answer: "x".repeat(4000),
  }));
  const embed = buildReviewEmbed(record({ answers, status: "denied", reviewerId: "9", reason: "r".repeat(1000) }), null);
  const json = embed.toJSON();
  const total =
    (json.title?.length ?? 0) +
    (json.description?.length ?? 0) +
    (json.footer?.text.length ?? 0) +
    (json.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `embed is ${total} chars`);
  assert.ok((json.fields ?? []).length <= 25);
});

test("the thread verdict (formerly plain text) is a container in the status colour", () => {
  const json = buildVerdictContainer(record({ status: "accepted", reviewerId: "9", decidedAt: new Date() })).toContainerComponent();
  assert.equal(json.type, ComponentType.Container);
  assert.equal(json.accentColor, 0x22c55e);
  assert.match(allText(json).join(""), /<:icons_Correct:\d+> Accepted by <@9>/);
});

test("decision DMs (formerly plain text) are titled containers carrying the server's message", () => {
  const guild = { client: {}, name: "Test Server", iconURL: () => null } as never;
  const opening = zApplicationsConfig.parse({ openings: [{ id: OPENING, name: "Moderator" }] }).openings[0]!;
  const json = buildDecisionDm(guild, "accepted", opening, "Welcome aboard!").toContainerComponent();
  const text = allText(json).join(" ");
  assert.equal(json.type, ComponentType.Container);
  assert.match(text, /Application accepted/);
  assert.match(text, /Welcome aboard!/);
  assert.match(text, /Test Server · Moderator/);
});

test("review buttons disable once decided", () => {
  const pending = buildReviewButtons(record()).toJSON().components;
  const decided = buildReviewButtons(record({ status: "accepted" })).toJSON().components;
  assert.ok(pending.every((c) => !("disabled" in c) || !c.disabled));
  assert.ok(decided.every((c) => "disabled" in c && c.disabled));
});

test("review buttons use Dreamliner's app emojis, parsed into real custom emoji IDs", () => {
  const ids = buildReviewButtons(record())
    .toJSON()
    .components.map((c) => ("emoji" in c ? c.emoji?.id : undefined));
  assert.deepEqual(ids, ["1544417199798886530", "1544417460638457937"]);
  const status = buildReviewEmbed(record(), null).toJSON().fields!.at(-1)!.value;
  assert.match(status, /^<:icons_hoursglass:\d+> Waiting/);
});
