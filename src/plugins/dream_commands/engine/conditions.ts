/**
 * If-block conditions. "Matches a pattern" uses a tiny glob (* and ?) with a linear-time
 * matcher, never a regular expression from the builder, so no pattern can hang the bot.
 */
import { PermissionFlagsBits } from "discord.js";
import { channelInList, guildChannelScope } from "../../../core/channelMatch.js";
import type { CatalogField } from "./fields.js";
import type { RunCtx } from "./runtime.js";
import { resolveMember, StepError } from "./runtime.js";
import { interpolate, toNumber } from "./vars.js";
import type { Condition } from "./types.js";

export type ConditionDef = {
  type: string;
  label: string;
  description: string;
  fields: CatalogField[];
  defaults: Record<string, unknown>;
  evaluate: (ctx: RunCtx, c: Condition) => Promise<boolean> | boolean;
};

const MAX_TEXT = 2000;
const MAX_PATTERN = 200;

/**
 * Glob match, case-insensitive: * = any run of characters, ? = one character. Greedy two-pointer
 * algorithm with backtracking to the last star only, O(n*m) worst case on capped lengths.
 */
export function globMatch(text: string, pattern: string): boolean {
  const s = text.slice(0, MAX_TEXT).toLowerCase();
  const p = pattern.slice(0, MAX_PATTERN).toLowerCase();
  let si = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      si++;
      pi++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

const raw = (ctx: RunCtx, value: unknown) => interpolate(typeof value === "string" ? value : "", ctx.vars, { mode: "raw", rng: ctx.rng }).slice(0, MAX_TEXT);

export const COMPARE_OPS = [
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "starts", label: "starts with" },
  { value: "ends", label: "ends with" },
  { value: "matches", label: "matches the pattern (* and ?)" },
  { value: "gt", label: "is more than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
  { value: "empty", label: "is empty" },
  { value: "not_empty", label: "is not empty" },
];

export function compare(left: string, op: string, right: string, caseSensitive = false): boolean {
  const a = caseSensitive ? left : left.toLowerCase();
  const b = caseSensitive ? right : right.toLowerCase();
  switch (op) {
    case "eq": {
      const na = toNumber(left);
      const nb = toNumber(right);
      return na !== null && nb !== null && left.trim() !== "" && right.trim() !== "" ? na === nb : a.trim() === b.trim();
    }
    case "neq":
      return !compare(left, "eq", right, caseSensitive);
    case "contains":
      return b !== "" && a.includes(b);
    case "not_contains":
      return b === "" || !a.includes(b);
    case "starts":
      return a.startsWith(b);
    case "ends":
      return a.endsWith(b);
    case "matches":
      return globMatch(left, right);
    case "empty":
      return left.trim() === "";
    case "not_empty":
      return left.trim() !== "";
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const na = toNumber(left);
      const nb = toNumber(right);
      if (na === null || nb === null) return false;
      return op === "gt" ? na > nb : op === "gte" ? na >= nb : op === "lt" ? na < nb : na <= nb;
    }
    default:
      return false;
  }
}

const targetField: CatalogField = { key: "target", label: "Who", kind: "user_target", required: true };
const ageOps = [
  { value: "gte", label: "at least" },
  { value: "lt", label: "less than" },
];

export const CONDITIONS: ConditionDef[] = [
  {
    type: "compare",
    label: "Compare values",
    description: "Compare a variable with a value: is, contains, more than and so on.",
    fields: [
      { key: "left", label: "Value", kind: "text", maxLength: 500, variables: true, required: true },
      { key: "op", label: "Check", kind: "select", options: COMPARE_OPS },
      { key: "right", label: "To", kind: "text", maxLength: 500, variables: true, showIf: { key: "op", in: COMPARE_OPS.map((o) => o.value).filter((v) => v !== "empty" && v !== "not_empty") } },
      { key: "caseSensitive", label: "Match capital letters exactly", kind: "boolean" },
    ],
    defaults: { left: "", op: "eq", right: "", caseSensitive: false },
    evaluate: (ctx, c) => compare(raw(ctx, c.left), String(c.op ?? "eq"), raw(ctx, c.right), c.caseSensitive === true),
  },
  {
    type: "option_provided",
    label: "Option was filled in",
    description: "Whether the person filled in an optional option.",
    fields: [{ key: "option", label: "Option", kind: "text", maxLength: 32, required: true }],
    defaults: { option: "" },
    evaluate: (ctx, c) => {
      const value = ctx.vars.values.get(`option.${String(c.option ?? "").toLowerCase()}`);
      return value !== undefined && value !== "";
    },
  },
  {
    type: "has_role",
    label: "Has a role",
    description: "Whether someone has any or all of some roles.",
    fields: [
      { key: "roles", label: "Roles", kind: "roles", required: true, maxItems: 10 },
      { key: "mode", label: "Needs", kind: "select", options: [{ value: "any", label: "Any of them" }, { value: "all", label: "All of them" }] },
      { ...targetField },
    ],
    defaults: { roles: [], mode: "any", target: "{user.id}" },
    evaluate: async (ctx, c) => {
      const member = await resolveMember(ctx, c.target);
      const roles = Array.isArray(c.roles) ? (c.roles as string[]) : [];
      if (!roles.length) return false;
      return c.mode === "all" ? roles.every((r) => member.roles.cache.has(r)) : roles.some((r) => member.roles.cache.has(r));
    },
  },
  {
    type: "has_permission",
    label: "Has a permission",
    description: "Whether someone has a Discord permission in this server.",
    fields: [{ key: "permission", label: "Permission", kind: "permissions", required: true }, { ...targetField }],
    defaults: { permission: ["ManageMessages"], target: "{user.id}" },
    evaluate: async (ctx, c) => {
      const member = await resolveMember(ctx, c.target);
      const perms = Array.isArray(c.permission) ? (c.permission as string[]) : [];
      return perms.length > 0 && perms.every((p) => p in PermissionFlagsBits && member.permissions.has(PermissionFlagsBits[p as keyof typeof PermissionFlagsBits]));
    },
  },
  {
    type: "in_channel",
    label: "Used in a channel",
    description: "Whether the command was used in some channels or categories.",
    fields: [{ key: "channels", label: "Channels or categories", kind: "channels", allowCategories: true, required: true, maxItems: 25 }],
    defaults: { channels: [] },
    evaluate: (ctx, c) => channelInList(Array.isArray(c.channels) ? (c.channels as string[]) : [], guildChannelScope(ctx.guild, ctx.channelId)),
  },
  {
    type: "chance",
    label: "Random chance",
    description: "True a percentage of the time.",
    fields: [{ key: "percent", label: "Chance (%)", kind: "number", min: 0, max: 100 }],
    defaults: { percent: 50 },
    evaluate: (ctx, c) => ctx.rng() * 100 < Math.max(0, Math.min(100, typeof c.percent === "number" ? c.percent : 50)),
  },
  {
    type: "is_bot",
    label: "Is a bot",
    description: "Whether someone is a bot account.",
    fields: [{ ...targetField }],
    defaults: { target: "{user.id}" },
    evaluate: async (ctx, c) => (await resolveMember(ctx, c.target)).user.bot,
  },
  {
    type: "account_age",
    label: "Account age",
    description: "How many days ago someone made their Discord account.",
    fields: [{ key: "op", label: "Is", kind: "select", options: ageOps }, { key: "days", label: "Days", kind: "number", integer: true, min: 0, max: 10000 }, { ...targetField }],
    defaults: { op: "gte", days: 7, target: "{user.id}" },
    evaluate: async (ctx, c) => {
      const member = await resolveMember(ctx, c.target);
      const days = (Date.now() - member.user.createdTimestamp) / 86400_000;
      return c.op === "lt" ? days < Number(c.days ?? 0) : days >= Number(c.days ?? 0);
    },
  },
  {
    type: "member_age",
    label: "Time in this server",
    description: "How many days ago someone joined this server.",
    fields: [{ key: "op", label: "Is", kind: "select", options: ageOps }, { key: "days", label: "Days", kind: "number", integer: true, min: 0, max: 10000 }, { ...targetField }],
    defaults: { op: "gte", days: 7, target: "{user.id}" },
    evaluate: async (ctx, c) => {
      const member = await resolveMember(ctx, c.target);
      if (!member.joinedTimestamp) return false;
      const days = (Date.now() - member.joinedTimestamp) / 86400_000;
      return c.op === "lt" ? days < Number(c.days ?? 0) : days >= Number(c.days ?? 0);
    },
  },
  {
    type: "passport_verified",
    label: "Passport verified",
    description: "Whether someone passed Passport verification here.",
    fields: [{ ...targetField }],
    defaults: { target: "{user.id}" },
    evaluate: async (ctx, c) => {
      const member = await resolveMember(ctx, c.target);
      const { getPassportVerification } = await import("../../passport/functions/store.js");
      return Boolean(await getPassportVerification(ctx.guild.id, member.id));
    },
  },
];

export const CONDITION_MAP = new Map(CONDITIONS.map((c) => [c.type, c]));

export async function evaluateCondition(ctx: RunCtx, c: Condition): Promise<boolean> {
  const def = CONDITION_MAP.get(c.type);
  if (!def) throw new StepError("Unknown condition.");
  const result = await def.evaluate(ctx, c);
  return c.negate ? !result : result;
}
