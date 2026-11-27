import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { zTicketFormQuestion } from "../config/schemas/tickets.js";
import { buildFormModal } from "./formModal.js";

type RawComponent = { type: number; label?: string; description?: string; component?: RawComponent; components?: RawComponent[] };

const LABEL = 18;
const ACTION_ROW = 1;
const TEXT_INPUT = 4;

function modalComponents(questions: Record<string, unknown>[], extras?: (index: number) => { description?: string } | undefined): RawComponent[] {
  const modal = buildFormModal({
    customId: "test",
    title: "Test form",
    questions: questions.map((q) => zTicketFormQuestion.parse({ id: randomUUID(), ...q })),
    fieldId: (index) => `q${index}`,
    extras,
  });
  return modal.toJSON().components as unknown as RawComponent[];
}

test("a text question with help text puts the label on the Label wrapper only (Discord 50035)", () => {
  const [component] = modalComponents([{ label: "Why do you want to join?", type: "text" }], () => ({ description: "A few sentences" }));
  assert.equal(component!.type, LABEL);
  assert.equal(component!.label, "Why do you want to join?");
  assert.equal(component!.description, "A few sentences");
  assert.equal(component!.component?.type, TEXT_INPUT);
  assert.equal(component!.component?.label, undefined, "a TextInput inside a Label must not carry its own label");
});

test("a text question without help text stays a classic action row with a labelled input", () => {
  const [component] = modalComponents([{ label: "Your name", type: "text" }]);
  assert.equal(component!.type, ACTION_ROW);
  const input = component!.components?.[0];
  assert.equal(input?.type, TEXT_INPUT);
  assert.equal(input?.label, "Your name");
});
