/**
 * Logic and interaction blocks. Their nested step lists are validated by the program validator
 * (validate.ts) and run by the interpreter; this file describes their settings for the catalog.
 */
import { z } from "zod";
import type { ActionDef } from "../action.js";
import { messageField, ephemeralField } from "./messages.js";
import { LIMITS } from "../types.js";

const anyList = z.array(z.unknown()).max(LIMITS.totalSteps);

const whoFields = [
  {
    key: "who",
    label: "Who can press",
    kind: "select" as const,
    options: [
      { value: "runner", label: "Only the person who ran it" },
      { value: "anyone", label: "Anyone" },
      { value: "roles", label: "People with these roles" },
    ],
  },
  { key: "roleIds", label: "Roles", kind: "roles" as const, maxItems: 10, showIf: { key: "who", in: ["roles"] } },
  { key: "singleUse", label: "Works once, then turns off", kind: "boolean" as const },
];

export const blockActions: ActionDef[] = [
  {
    type: "if",
    category: "logic",
    label: "If",
    description: "Only run some steps when conditions are true, with Else if and Otherwise.",
    icon: "branch",
    block: "if",
    fields: [],
    outputs: [],
    defaults: { branches: [{ match: "all", conditions: [], steps: [] }], else: [] },
    extraSchema: {
      branches: z
        .array(z.strictObject({ match: z.enum(["all", "any"]), conditions: z.array(z.record(z.unknown())).max(LIMITS.conditions), steps: anyList }))
        .min(1)
        .max(LIMITS.branches),
      else: anyList,
    },
    summary: "Check conditions, then run the matching steps",
  },
  {
    type: "repeat",
    category: "logic",
    label: "Repeat",
    description: `Run some steps several times (up to ${LIMITS.repeatTimes}).`,
    icon: "repeat",
    block: "repeat",
    fields: [{ key: "times", label: "Times", kind: "number", integer: true, min: 1, max: LIMITS.repeatTimes }],
    outputs: [],
    defaults: { times: 3, steps: [] },
    extraSchema: { steps: anyList },
    summary: "Repeat {times} times",
  },
  {
    type: "repeat_each",
    category: "logic",
    label: "Repeat for each",
    description: `Run some steps for each item in a list or each member of a role (up to ${LIMITS.repeatEach}).`,
    icon: "list",
    block: "repeat_each",
    fields: [
      { key: "source", label: "For each", kind: "select", options: [{ value: "list", label: "Item in a list" }, { value: "role_members", label: "Member with a role" }] },
      { key: "list", label: "List", kind: "textarea", maxLength: 2000, variables: true, showIf: { key: "source", in: ["list"] }, help: "Items separated by commas or new lines, or a list variable." },
      { key: "separator", label: "Separated by", kind: "select", options: [{ value: "newline", label: "New lines" }, { value: "comma", label: "Commas" }], showIf: { key: "source", in: ["list"] } },
      { key: "roleId", label: "Role", kind: "role", showIf: { key: "source", in: ["role_members"] } },
      { key: "limit", label: "At most", kind: "number", integer: true, min: 1, max: LIMITS.repeatEach },
    ],
    outputs: [],
    defaults: { source: "list", list: "", separator: "newline", roleId: "", limit: 10, steps: [] },
    extraSchema: { steps: anyList },
    summary: "Repeat for each item ({limit} at most)",
  },
  {
    type: "random_branch",
    category: "logic",
    label: "Choose at random",
    description: "Run one of several step lists, picked at random with weights.",
    icon: "random",
    block: "random_branch",
    fields: [],
    outputs: [{ key: "picked", label: "Picked path (from 1)" }],
    defaults: { branches: [{ weight: 1, steps: [] }, { weight: 1, steps: [] }] },
    extraSchema: { branches: z.array(z.strictObject({ weight: z.number().min(0).max(1000), steps: anyList })).min(1).max(LIMITS.branches) },
    summary: "Choose a path at random",
  },
  {
    type: "wait",
    category: "logic",
    label: "Wait",
    description: "Pause before the next step (up to 15 minutes in total per run).",
    icon: "wait",
    block: "wait",
    fields: [{ key: "seconds", label: "Seconds", kind: "number", integer: true, min: 1, max: LIMITS.waitTotalSeconds }],
    outputs: [],
    defaults: { seconds: 5 },
    summary: "Wait {seconds} seconds",
  },
  {
    type: "stop",
    category: "logic",
    label: "Stop",
    description: "End the command here, optionally with a message only they see.",
    icon: "stop",
    block: "stop",
    fields: [
      { key: "message", label: "Message (optional)", kind: "text", maxLength: 500, variables: true },
      { key: "asError", label: "Show it as an error", kind: "boolean" },
    ],
    outputs: [],
    defaults: { message: "", asError: false },
    summary: "Stop",
  },
  {
    type: "buttons",
    category: "interactions",
    label: "Reply with buttons",
    description: "Send a message with up to 5 buttons. Each button runs its own steps when pressed (works for 24 hours).",
    icon: "buttons",
    block: "buttons",
    fields: [messageField("Message"), ephemeralField, ...whoFields],
    outputs: [
      { key: "message.id", label: "Message ID" },
      { key: "pressed", label: "Button pressed (label)" },
    ],
    defaults: { ephemeral: "default", who: "runner", roleIds: [], singleUse: false, buttons: [{ id: "b1", label: "Click me", style: "primary", emoji: "", steps: [] }] },
    extraSchema: {
      buttons: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z0-9]{1,8}$/),
            label: z.string().min(1).max(80),
            style: z.enum(["primary", "secondary", "success", "danger"]),
            emoji: z.string().max(100),
            steps: anyList,
          }),
        )
        .min(1)
        .max(LIMITS.buttons),
    },
    summary: "Reply with buttons",
  },
  {
    type: "select_menu",
    category: "interactions",
    label: "Reply with a menu",
    description: "Send a message with a dropdown menu. Each choice runs its own steps (works for 24 hours).",
    icon: "menu",
    block: "select_menu",
    fields: [messageField("Message"), ephemeralField, { key: "placeholder", label: "Menu placeholder", kind: "text", maxLength: 150 }, ...whoFields],
    outputs: [
      { key: "message.id", label: "Message ID" },
      { key: "picked", label: "Choice picked (label)" },
    ],
    defaults: { ephemeral: "default", placeholder: "Pick one", who: "runner", roleIds: [], singleUse: false, options: [{ id: "o1", label: "First choice", description: "", emoji: "", steps: [] }] },
    extraSchema: {
      options: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z0-9]{1,8}$/),
            label: z.string().min(1).max(100),
            description: z.string().max(100),
            emoji: z.string().max(100),
            steps: anyList,
          }),
        )
        .min(1)
        .max(LIMITS.selectOptions),
    },
    summary: "Reply with a menu",
  },
  {
    type: "form",
    category: "interactions",
    label: "Ask with a form",
    description: "Show a pop-up form with up to 5 questions. Must be the first step (or first inside a button). Answers become {form.question}.",
    icon: "form",
    block: "form",
    fields: [{ key: "title", label: "Form title", kind: "text", required: true, maxLength: 45, variables: true }],
    outputs: [],
    defaults: { title: "Tell us more", inputs: [{ id: "answer", label: "Your answer", style: "short", required: true, placeholder: "", minLength: null, maxLength: null }] },
    extraSchema: {
      inputs: z
        .array(
          z.strictObject({
            id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
            label: z.string().min(1).max(45),
            style: z.enum(["short", "paragraph"]),
            required: z.boolean(),
            placeholder: z.string().max(100),
            minLength: z.number().int().min(0).max(4000).nullable(),
            maxLength: z.number().int().min(1).max(4000).nullable(),
          }),
        )
        .min(1)
        .max(LIMITS.formInputs),
    },
    summary: "Ask with a form: {title}",
  },
];
