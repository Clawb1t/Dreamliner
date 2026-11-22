import { ChannelType, GuildVerificationLevel } from "discord.js";
import type { ActionDef } from "../action.js";
import { arr, bool, channelTargetField, num, str, userTargetField } from "../action.js";
import { channelKindName, checkDeadline, resolveChannel, resolveMember, resolveRole, spendApi, StepError } from "../runtime.js";
import { LIMITS } from "../types.js";
import { interpolate, toNumber, valueToText } from "../vars.js";

const VERIFICATION: Record<number, string> = {
  [GuildVerificationLevel.None]: "None",
  [GuildVerificationLevel.Low]: "Low",
  [GuildVerificationLevel.Medium]: "Medium",
  [GuildVerificationLevel.High]: "High",
  [GuildVerificationLevel.VeryHigh]: "Highest",
};

const ts = (date: Date | null | undefined) => (date ? `<t:${Math.floor(date.getTime() / 1000)}:D>` : "");

export const utilityActions: ActionDef[] = [
  {
    type: "log",
    category: "utilities",
    label: "Write to the log channel",
    description: "Post a line in Dreamliner's server log channel (Logs plugin settings).",
    icon: "log",
    fields: [
      { key: "title", label: "Title", kind: "text", required: true, maxLength: 200, variables: true },
      { key: "text", label: "Details", kind: "textarea", maxLength: 1500, variables: true },
    ],
    outputs: [],
    defaults: { title: "/{command} used", text: "{user.mention} used /{command} in {channel}." },
    summary: "Log {title}",
    run: async (ctx, config) => {
      const { emitLog } = await import("../../../../core/logging/send.js");
      const { buildGenericServerLog } = await import("../../../../core/logging/format.js");
      const title = interpolate(str(config, "title"), ctx.vars, { mode: "message", rng: ctx.rng }).slice(0, 200) || `/${ctx.commandName}`;
      const text = interpolate(str(config, "text"), ctx.vars, { mode: "message", rng: ctx.rng }).slice(0, 1500);
      spendApi(ctx);
      await emitLog(ctx.client, ctx.guildConfig, buildGenericServerLog(title, text ? text.split("\n").slice(0, 15) : []), {
        guildId: ctx.guild.id,
        eventType: "dreamcode_server",
        summary: title,
        actorId: ctx.runner.id,
        channelId: ctx.channelId,
      });
    },
  },
  {
    type: "member_info",
    category: "utilities",
    label: "Get member info",
    description: "Look up a member's name, avatar, join date, roles and more.",
    icon: "user",
    fields: [userTargetField()],
    outputs: [
      { key: "user.name", label: "Username" },
      { key: "user.display_name", label: "Display name" },
      { key: "user.mention", label: "Mention" },
      { key: "user.id", label: "ID" },
      { key: "user.avatar_url", label: "Avatar link" },
      { key: "user.joined_at", label: "Joined the server" },
      { key: "user.created_at", label: "Account created" },
      { key: "user.roles", label: "Roles (list)" },
      { key: "user.top_role", label: "Highest role" },
      { key: "user.bot", label: "Is a bot" },
      { key: "user.boosting", label: "Boosting (true or false)" },
    ],
    defaults: { target: "{user.id}" },
    summary: "Get info about {target}",
    run: async (ctx, config) => {
      const m = await resolveMember(ctx, config.target);
      const roles = [...m.roles.cache.values()].filter((r) => r.id !== ctx.guild.id).sort((a, b) => b.position - a.position);
      return {
        outputs: {
          "user.name": m.user.username,
          "user.display_name": m.displayName,
          "user.mention": `<@${m.id}>`,
          "user.id": m.id,
          "user.avatar_url": m.displayAvatarURL({ size: 512 }),
          "user.joined_at": ts(m.joinedAt),
          "user.created_at": ts(m.user.createdAt),
          "user.roles": roles.slice(0, 50).map((r) => r.name),
          "user.top_role": roles[0]?.name ?? "",
          "user.bot": m.user.bot,
          "user.boosting": Boolean(m.premiumSince),
        },
        trusted: ["user.mention", "user.id", "user.avatar_url", "user.joined_at", "user.created_at"],
      };
    },
  },
  {
    type: "server_info",
    category: "utilities",
    label: "Get server info",
    description: "Member count, boosts, channels, roles and creation date.",
    icon: "server",
    fields: [],
    outputs: [
      { key: "members", label: "Members" },
      { key: "boosts", label: "Boosts" },
      { key: "boost_tier", label: "Boost level" },
      { key: "channels", label: "Channels" },
      { key: "roles", label: "Roles" },
      { key: "emojis", label: "Emojis" },
      { key: "created_at", label: "Created" },
      { key: "verification", label: "Verification level" },
    ],
    summary: "Get server info",
    run: async (ctx) => {
      const g = ctx.guild;
      return {
        outputs: {
          members: g.memberCount,
          boosts: g.premiumSubscriptionCount ?? 0,
          boost_tier: g.premiumTier,
          channels: g.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory && !c.isThread()).size,
          roles: g.roles.cache.size - 1,
          emojis: g.emojis.cache.size,
          created_at: ts(g.createdAt),
          verification: VERIFICATION[g.verificationLevel] ?? "",
        },
        trusted: ["created_at"],
      };
    },
  },
  {
    type: "role_info",
    category: "utilities",
    label: "Get role info",
    description: "A role's name, colour and how many members have it.",
    icon: "info",
    fields: [{ key: "role", label: "Role", kind: "role_target", required: true }],
    outputs: [
      { key: "role.name", label: "Name" },
      { key: "role.mention", label: "Mention" },
      { key: "role.id", label: "ID" },
      { key: "role.members", label: "Members with it" },
      { key: "role.color", label: "Colour (hex)" },
    ],
    summary: "Get info about {role}",
    run: async (ctx, config) => {
      const role = resolveRole(ctx, config.role);
      return {
        outputs: { "role.name": role.name, "role.mention": `<@&${role.id}>`, "role.id": role.id, "role.members": role.members.size, "role.color": role.hexColor },
        trusted: ["role.mention", "role.id"],
      };
    },
  },
  {
    type: "channel_info",
    category: "utilities",
    label: "Get channel info",
    description: "A channel's name, type, topic and category.",
    icon: "info",
    fields: [channelTargetField("channel", "Channel")],
    outputs: [
      { key: "channel.name", label: "Name" },
      { key: "channel", label: "Mention" },
      { key: "channel.id", label: "ID" },
      { key: "channel.type", label: "Type" },
      { key: "channel.topic", label: "Topic" },
      { key: "channel.category", label: "Category name" },
    ],
    defaults: { channel: "{channel.id}" },
    summary: "Get info about {channel}",
    run: async (ctx, config) => {
      const c = await resolveChannel(ctx, config.channel);
      return {
        outputs: {
          "channel.name": c.name,
          channel: `<#${c.id}>`,
          "channel.id": c.id,
          "channel.type": channelKindName(c.type),
          "channel.topic": "topic" in c && typeof c.topic === "string" ? c.topic : "",
          "channel.category": c.parent && !c.isThread() ? c.parent.name : "",
        },
        trusted: ["channel", "channel.id"],
      };
    },
  },
  {
    type: "random_member",
    category: "utilities",
    label: "Pick a random member",
    description: "Pick someone at random, optionally only people with a role.",
    icon: "shuffle",
    fields: [
      { key: "role", label: "Only people with this role (optional)", kind: "role_target" },
      { key: "excludeBots", label: "Leave out bots", kind: "boolean" },
      { key: "excludeRunner", label: "Leave out the person who ran it", kind: "boolean" },
    ],
    outputs: [
      { key: "member", label: "Mention" },
      { key: "member.id", label: "ID" },
      { key: "member.name", label: "Display name" },
      { key: "user.id", label: "ID (same as member ID)" },
    ],
    defaults: { role: "", excludeBots: true, excludeRunner: false },
    summary: "Pick a random member",
    run: async (ctx, config) => {
      const pool = str(config, "role").trim() ? [...resolveRole(ctx, config.role).members.values()] : [...ctx.guild.members.cache.values()];
      const candidates = pool.filter((m) => (!bool(config, "excludeBots") || !m.user.bot) && (!bool(config, "excludeRunner") || m.id !== ctx.runner.id));
      if (!candidates.length) throw new StepError("Nobody matched, so no one could be picked.");
      const pick = candidates[Math.floor(ctx.rng() * candidates.length)]!;
      return { outputs: { member: `<@${pick.id}>`, "member.id": pick.id, "member.name": pick.displayName, "user.id": pick.id }, trusted: ["member", "member.id", "user.id"] };
    },
  },
  {
    type: "random_item",
    category: "utilities",
    label: "Pick from a list",
    description: "Pick one item at random, like an 8 ball answer or a prize.",
    icon: "random",
    fields: [{ key: "items", label: "Items", kind: "list", required: true, maxItems: 100, maxLength: 500, variables: true, help: "One per line." }],
    outputs: [
      { key: "item", label: "Picked item" },
      { key: "index", label: "Position (from 1)" },
    ],
    defaults: { items: ["Yes", "No", "Maybe"] },
    summary: "Pick one of {items}",
    run: async (ctx, config) => {
      const items = arr(config, "items").map((i) => interpolate(i, ctx.vars, { mode: "raw", rng: ctx.rng })).filter((i) => i.trim());
      if (!items.length) throw new StepError("The list is empty.");
      const index = Math.floor(ctx.rng() * items.length);
      return { outputs: { item: items[index]!, index: index + 1 } };
    },
  },
  {
    type: "roll_dice",
    category: "utilities",
    label: "Roll dice",
    description: "Roll one or more dice with any number of sides.",
    icon: "dice",
    fields: [
      { key: "count", label: "Dice", kind: "number", integer: true, min: 1, max: 20 },
      { key: "sides", label: "Sides", kind: "number", integer: true, min: 2, max: 1000 },
    ],
    outputs: [
      { key: "total", label: "Total" },
      { key: "rolls", label: "Each roll (list)" },
    ],
    defaults: { count: 1, sides: 6 },
    summary: "Roll {count} dice with {sides} sides",
    run: async (ctx, config) => {
      const count = Math.min(20, Math.max(1, num(config, "count", 1)));
      const sides = Math.min(1000, Math.max(2, num(config, "sides", 6)));
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(ctx.rng() * sides));
      return { outputs: { total: rolls.reduce((a, b) => a + b, 0), rolls: rolls.map(String) } };
    },
  },
  {
    type: "timestamp",
    category: "utilities",
    label: "Make a timestamp",
    description: "A time that shows in everyone's own time zone, like a countdown.",
    icon: "clock",
    fields: [
      { key: "offsetMinutes", label: "Minutes from now (0 = now)", kind: "text", maxLength: 60, variables: true, help: "A number, or a variable holding one." },
      {
        key: "style",
        label: "Show as",
        kind: "select",
        options: [
          { value: "R", label: "Relative (in 5 minutes)" },
          { value: "f", label: "Date and time" },
          { value: "F", label: "Full date and time" },
          { value: "D", label: "Date" },
          { value: "t", label: "Time" },
        ],
      },
    ],
    outputs: [
      { key: "text", label: "Timestamp" },
      { key: "unix", label: "Unix seconds" },
    ],
    defaults: { offsetMinutes: "0", style: "R" },
    summary: "Make a timestamp",
    run: async (ctx, config) => {
      const offset = toNumber(interpolate(str(config, "offsetMinutes"), ctx.vars, { mode: "raw", rng: ctx.rng })) ?? 0;
      const clamped = Math.max(-5_256_000, Math.min(5_256_000, offset));
      const unix = Math.floor(Date.now() / 1000 + clamped * 60);
      const style = /^[tTdDfFR]$/.test(str(config, "style")) ? str(config, "style") : "R";
      return { outputs: { text: `<t:${unix}:${style}>`, unix }, trusted: ["text"] };
    },
  },
  {
    type: "poll",
    category: "utilities",
    label: "Start a poll",
    description: "Reply with a Discord poll.",
    icon: "poll",
    fields: [
      { key: "question", label: "Question", kind: "text", required: true, maxLength: 300, variables: true },
      { key: "answers", label: "Answers", kind: "list", required: true, maxItems: 10, maxLength: 55, variables: true, help: "2 to 10, one per line." },
      { key: "hours", label: "Runs for (hours)", kind: "number", integer: true, min: 1, max: 768 },
      { key: "multiple", label: "Allow picking more than one", kind: "boolean" },
    ],
    outputs: [{ key: "message.id", label: "Message ID" }],
    defaults: { question: "What should we do?", answers: ["Option A", "Option B"], hours: 24, multiple: false },
    summary: "Start a poll: {question}",
    validate: (config, v) => {
      if (arr(config, "answers").filter((a) => a.trim()).length < 2) v.issue("answers", "Add at least 2 answers.");
    },
    run: async (ctx, config, step) => {
      const answers = arr(config, "answers")
        .map((a) => interpolate(a, ctx.vars, { mode: "raw", rng: ctx.rng }).trim().slice(0, 55))
        .filter(Boolean)
        .slice(0, 10);
      if (answers.length < 2) throw new StepError("A poll needs at least 2 answers.");
      const question = interpolate(str(config, "question"), ctx.vars, { mode: "raw", rng: ctx.rng }).trim().slice(0, 300) || "Poll";
      spendApi(ctx);
      const message = await ctx.responder.send(
        {
          poll: { question: { text: question }, answers: answers.map((text) => ({ text })), duration: Math.min(768, Math.max(1, num(config, "hours", 24))), allowMultiselect: bool(config, "multiple") },
          allowedMentions: { parse: [] },
        },
        false,
      );
      if (message?.id) {
        ctx.messages.set(step.id, { channelId: ctx.channelId, messageId: message.id });
        if (!ctx.messages.has("reply")) ctx.messages.set("reply", { channelId: ctx.channelId, messageId: message.id });
      }
      return { outputs: { "message.id": message?.id ?? "" }, trusted: ["message.id"] };
    },
  },
];

// ── Variables ───────────────────────────────────────────────────────────────────────────────

const VAR_NAME = /^[a-z][a-z0-9_]{0,23}$/;
const nameField = { key: "name", label: "Save as variable", kind: "text" as const, maxLength: 24, placeholder: "score", help: "Lowercase letters, numbers and _. Use it later as {var.name}." };

function setNamed(ctx: Parameters<NonNullable<ActionDef["run"]>>[0], config: Record<string, unknown>, value: unknown) {
  const name = str(config, "name").trim().toLowerCase();
  if (name && VAR_NAME.test(name)) ctx.vars.values.set(`var.${name}`, typeof value === "number" || Array.isArray(value) ? value : String(value ?? ""));
}

function validName(required: boolean) {
  return (config: Record<string, unknown>, v: { issue(f: string, m: string): void }) => {
    const name = str(config, "name").trim();
    if (!name && required) v.issue("name", "Give the variable a name.");
    else if (name && !VAR_NAME.test(name)) v.issue("name", "Use lowercase letters, numbers and _ (start with a letter).");
  };
}

export const variableActions: ActionDef[] = [
  {
    type: "set_variable",
    category: "variables",
    label: "Set a variable",
    description: "Remember a value to use in later steps as {var.name}.",
    icon: "variable",
    fields: [
      { ...nameField, label: "Variable name", required: true },
      { key: "value", label: "Value", kind: "textarea", maxLength: 2000, variables: true },
      { key: "valueType", label: "Type", kind: "select", options: [{ value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "list", label: "List (one per line)" }] },
    ],
    outputs: [{ key: "value", label: "Value" }],
    defaults: { name: "", value: "", valueType: "text" },
    summary: "Set {name} to {value}",
    validate: validName(true),
    run: async (ctx, config) => {
      const text = interpolate(str(config, "value"), ctx.vars, { mode: "raw", rng: ctx.rng });
      const value: string | number | string[] =
        config.valueType === "number" ? (toNumber(text) ?? 0) : config.valueType === "list" ? text.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, LIMITS.listItems) : text;
      setNamed(ctx, config, value);
      return { outputs: { value } };
    },
  },
  {
    type: "math",
    category: "variables",
    label: "Calculate",
    description: "Add, subtract, multiply, divide, round or pick a random number.",
    icon: "math",
    fields: [
      {
        key: "operation",
        label: "Operation",
        kind: "select",
        options: [
          { value: "add", label: "A + B" },
          { value: "subtract", label: "A - B" },
          { value: "multiply", label: "A × B" },
          { value: "divide", label: "A ÷ B" },
          { value: "modulo", label: "Remainder of A ÷ B" },
          { value: "power", label: "A to the power of B" },
          { value: "round", label: "Round A to B decimals" },
          { value: "floor", label: "Round A down" },
          { value: "ceil", label: "Round A up" },
          { value: "abs", label: "A without its sign" },
          { value: "min", label: "Smaller of A and B" },
          { value: "max", label: "Bigger of A and B" },
          { value: "random", label: "Random whole number from A to B" },
        ],
      },
      { key: "a", label: "A", kind: "text", maxLength: 200, variables: true },
      { key: "b", label: "B", kind: "text", maxLength: 200, variables: true, showIf: { key: "operation", in: ["add", "subtract", "multiply", "divide", "modulo", "power", "round", "min", "max", "random"] } },
      nameField,
    ],
    outputs: [{ key: "result", label: "Result" }],
    defaults: { operation: "add", a: "1", b: "1", name: "" },
    summary: "Calculate {operation}, with A = {a} and B = {b}",
    validate: validName(false),
    run: async (ctx, config) => {
      const read = (k: string) => toNumber(interpolate(str(config, k), ctx.vars, { mode: "raw", rng: ctx.rng }));
      const a = read("a");
      const b = read("b");
      const op = str(config, "operation");
      const needsB = !["floor", "ceil", "abs"].includes(op);
      if (a === null || (needsB && b === null)) throw new StepError("Calculate needs numbers.");
      const B = b ?? 0;
      let result: number;
      switch (op) {
        case "add": result = a + B; break;
        case "subtract": result = a - B; break;
        case "multiply": result = a * B; break;
        case "divide":
          if (B === 0) throw new StepError("Can't divide by zero.");
          result = a / B;
          break;
        case "modulo":
          if (B === 0) throw new StepError("Can't divide by zero.");
          result = a % B;
          break;
        case "power": result = Math.pow(a, Math.max(-20, Math.min(20, B))); break;
        case "round": {
          const f = Math.pow(10, Math.max(0, Math.min(6, Math.floor(B))));
          result = Math.round(a * f) / f;
          break;
        }
        case "floor": result = Math.floor(a); break;
        case "ceil": result = Math.ceil(a); break;
        case "abs": result = Math.abs(a); break;
        case "min": result = Math.min(a, B); break;
        case "max": result = Math.max(a, B); break;
        case "random": {
          const lo = Math.ceil(Math.min(a, B));
          const hi = Math.floor(Math.max(a, B));
          result = lo + Math.floor(ctx.rng() * (hi - lo + 1));
          break;
        }
        default:
          throw new StepError("Unknown operation.");
      }
      if (!Number.isFinite(result) || Math.abs(result) > 1e15) throw new StepError("The result is too big.");
      setNamed(ctx, config, result);
      return { outputs: { result } };
    },
  },
  {
    type: "text_transform",
    category: "variables",
    label: "Change text",
    description: "Upper or lower case, length, replace, split into a list, shorten and more.",
    icon: "text",
    fields: [
      {
        key: "operation",
        label: "Operation",
        kind: "select",
        options: [
          { value: "upper", label: "UPPER CASE" },
          { value: "lower", label: "lower case" },
          { value: "title", label: "Title Case" },
          { value: "trim", label: "Remove spaces at the ends" },
          { value: "length", label: "Count characters" },
          { value: "words", label: "Count words" },
          { value: "replace", label: "Replace text" },
          { value: "split", label: "Split into a list" },
          { value: "join", label: "Join a list into text" },
          { value: "truncate", label: "Shorten" },
          { value: "reverse", label: "Reverse" },
        ],
      },
      { key: "input", label: "Text", kind: "textarea", maxLength: 2000, variables: true },
      { key: "find", label: "Find", kind: "text", maxLength: 200, showIf: { key: "operation", in: ["replace"] } },
      { key: "replaceWith", label: "Replace with", kind: "text", maxLength: 200, variables: true, showIf: { key: "operation", in: ["replace"] } },
      { key: "separator", label: "Separator", kind: "text", maxLength: 10, showIf: { key: "operation", in: ["split", "join"] }, placeholder: "," },
      { key: "length", label: "Max characters", kind: "number", integer: true, min: 1, max: 2000, showIf: { key: "operation", in: ["truncate"] } },
      nameField,
    ],
    outputs: [{ key: "result", label: "Result" }],
    defaults: { operation: "upper", input: "", find: "", replaceWith: "", separator: ",", length: 100, name: "" },
    summary: "Change {input}: {operation}",
    validate: validName(false),
    run: async (ctx, config) => {
      checkDeadline(ctx);
      const op = str(config, "operation");
      const inputKey = /^\{([a-z0-9_.:-]+)\}$/.exec(str(config, "input").trim())?.[1];
      const rawValue = inputKey ? ctx.vars.values.get(inputKey) : undefined;
      const input = interpolate(str(config, "input"), ctx.vars, { mode: "raw", rng: ctx.rng });
      let result: string | number | string[];
      switch (op) {
        case "upper": result = input.toUpperCase(); break;
        case "lower": result = input.toLowerCase(); break;
        case "title": result = input.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, s: string, c: string) => s + c.toUpperCase()); break;
        case "trim": result = input.trim(); break;
        case "length": result = [...input].length; break;
        case "words": result = input.trim() ? input.trim().split(/\s+/).length : 0; break;
        case "replace": {
          const find = str(config, "find");
          result = find ? input.split(find).join(interpolate(str(config, "replaceWith"), ctx.vars, { mode: "raw", rng: ctx.rng })) : input;
          break;
        }
        case "split": {
          const sep = str(config, "separator") || ",";
          result = input.split(sep).map((s) => s.trim()).filter(Boolean).slice(0, LIMITS.listItems);
          break;
        }
        case "join": {
          const sep = str(config, "separator") || ", ";
          result = Array.isArray(rawValue) ? rawValue.join(sep) : valueToText(rawValue ?? input);
          break;
        }
        case "truncate": {
          const max = Math.max(1, Math.min(2000, num(config, "length", 100)));
          result = input.length > max ? `${input.slice(0, Math.max(1, max - 1))}…` : input;
          break;
        }
        case "reverse": result = [...input].reverse().join(""); break;
        default:
          throw new StepError("Unknown operation.");
      }
      if (typeof result === "string") result = result.slice(0, LIMITS.varLength);
      setNamed(ctx, config, result);
      return { outputs: { result } };
    },
  },
];

