import { test } from "node:test";
import assert from "node:assert/strict";
import { zAppealForm } from "../../../config/schemas/appeals.js";
import { validateAppealAnswers } from "./validate.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const form = zAppealForm.parse({
  id: id(0),
  questions: [
    { id: id(1), label: "Why?", type: "text", style: "paragraph", min_length: 10, max_length: 50 },
    { id: id(2), label: "Optional", type: "text", required: false, min_length: 5 },
    { id: id(3), label: "Platform", type: "radio_group", options: [{ label: "PC", value: "pc" }, { label: "Phone", value: "phone" }] },
    { id: id(4), label: "Rules read", type: "checkbox_group", options: [{ label: "One", value: "1" }, { label: "Two", value: "2" }], min_values: 2 },
    { id: id(5), label: "I agree", type: "checkbox", required: true },
    { id: id(6), label: "Note", type: "text_display", content: "Be honest." },
  ],
});

const good = { [id(1)]: "I was spamming links", [id(2)]: "", [id(3)]: "pc", [id(4)]: ["1", "2"], [id(5)]: true };

test("accepts a complete form and records readable answers", () => {
  const result = validateAppealAnswers(form, good);
  assert.ok(result.ok);
  assert.deepEqual(
    result.answers.map((a) => a.answer),
    ["I was spamming links", "", "PC", "One, Two", "Yes"],
  );
});

test("enforces length limits, required answers, real options and the agreement box", () => {
  const result = validateAppealAnswers(form, {
    [id(1)]: "short",
    [id(2)]: "abc",
    [id(3)]: "tablet",
    [id(4)]: ["1"],
    [id(5)]: false,
  });
  assert.ok(!result.ok);
  assert.deepEqual(Object.keys(result.errors).sort(), [id(1), id(2), id(3), id(4), id(5)].sort());
  assert.match(result.errors[id(1)]!, /at least 10/);
});

test("too-long answers and missing required ones are caught", () => {
  const result = validateAppealAnswers(form, { ...good, [id(1)]: "x".repeat(51), [id(3)]: "" });
  assert.ok(!result.ok);
  assert.match(result.errors[id(1)]!, /under 50/);
  assert.match(result.errors[id(3)]!, /Pick an option/);
});

test("Discord-only question types aren't allowed in appeal forms", () => {
  assert.throws(() => zAppealForm.parse({ id: id(0), questions: [{ id: id(1), label: "Who?", type: "user_select" }] }));
});
