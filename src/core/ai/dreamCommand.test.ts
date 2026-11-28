/**
 * Autopilot for Custom Commands: the model's step envelope round-trips through the engine's own
 * validator, every limit is enforced on a draft, steps the builder couldn't save are refused, the
 * strict schema stays within OpenAI's rules, and the gated runner charges and refunds correctly.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { PermissionFlagsBits } from "discord.js";

const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-ai-cc-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;
process.env.DASHBOARD_BRIDGE_SECRET = "test-secret";
// No OpenAI key: every generation fails, which is what the refund test relies on.
delete process.env.OPENAI_API_KEY;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();
const { getDb } = await import("../../db/client.js");
const { TEMPLATES } = await import("../../plugins/dream_commands/engine/templates.js");
const { validateProgram } = await import("../../plugins/dream_commands/engine/validate.js");
const { LIMITS } = await import("../../plugins/dream_commands/engine/types.js");
const { ACTIONS } = await import("../../plugins/dream_commands/engine/registry.js");
const dc = await import("./dreamCommand.js");
const { runDreamCommandAutopilot } = await import("../../bridge/webAi.js");
const { AI_FREE_USES_LIMIT, getAiGateStatus } = await import("./usage.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* leftover temp dir is harmless */
  }
});

// ── Fakes ───────────────────────────────────────────────────────────────────────────────────

const GUILD = "100000000000000001";
const OWNER = "200000000000000001";
const BUILDER = "200000000000000002";
const R_MEMBER = "300000000000000001";
const CH = "400000000000000001";

function makeGuild(builderPerms: bigint, guildId = GUILD) {
  const roles = new Map([
    [guildId, { id: guildId, name: "@everyone", position: 0, managed: false, permissions: { bitfield: 0n } }],
    [R_MEMBER, { id: R_MEMBER, name: "Member", position: 2, managed: false, permissions: { bitfield: 0n } }],
  ]);
  const guild: Record<string, unknown> = { id: guildId, ownerId: OWNER, name: "Test", roles: { cache: roles }, emojis: { cache: new Map() } };
  const builder = {
    id: BUILDER,
    guild,
    permissions: { bitfield: builderPerms, has: (flag: bigint) => (builderPerms & flag) === flag },
    roles: { highest: { position: 5 } },
  };
  const members = new Map([[BUILDER, builder]]);
  guild.members = { cache: members, me: builder, fetch: async (id: string) => members.get(id) ?? Promise.reject(new Error("unknown")) };
  guild.channels = { cache: new Map([[CH, { id: CH, name: "general", type: 0 }]]) };
  return guild as never;
}

const actor = (permissions: bigint) => ({ userId: BUILDER, owner: false, administrator: false, superuser: false, permissions, highestPosition: 5 });
const ALL_ON = { plugins: {} as Record<string, { enabled?: boolean }> };
const ACCESS = { roles: [], rolesMode: "any", blockedRoles: [], permissions: [], channels: [], blockedChannels: [], visibility: [] };

function env(id: string, type: string, config: Record<string, unknown>, children: { list: string; steps: unknown[] }[] = []) {
  return { id, type, label: null, continueOnError: false, config_json: JSON.stringify(config), children };
}
const reply = (id: string, content: string) => env(id, "reply", { message: { format: "text", content } });

function raw(steps: unknown[], extra: Record<string, unknown> = {}) {
  return { name: "hello", description: "Say hello", ephemeral: false, options: [], access: ACCESS, cooldowns: { user: 0, channel: 0, global: 0 }, limits: { perUserDaily: 0, guildDaily: 0 }, steps, ...extra };
}

function check(rawCommand: Record<string, unknown>, perms = PermissionFlagsBits.Administrator, opts: Partial<{ taken: Set<string>; keepName: string | null }> = {}) {
  const a = actor(perms);
  return dc.checkDraft(makeGuild(perms), a, rawCommand, {
    taken: opts.taken ?? new Set(),
    reserved: new Set(["help", "config"]),
    keepName: opts.keepName ?? null,
    allowedTypes: dc.allowedActionTypes(ALL_ON, a),
  });
}

// ── Round trip ──────────────────────────────────────────────────────────────────────────────

describe("envelope round trip", () => {
  it("every template survives envelope -> program -> validator unchanged", () => {
    for (const t of TEMPLATES) {
      const expected = validateProgram(t.program);
      assert.ok(expected.program, t.id);
      const issues: { message: string }[] = [];
      const assembled = dc.assembleProgram({ ...t.program, name: t.commandName, steps: dc.toEnvelope(t.program.steps) }, issues as never);
      assert.deepEqual(issues, [], t.id);
      const again = validateProgram(assembled.program);
      assert.deepEqual(again.program, expected.program, t.id);
      assert.equal(assembled.name, t.commandName);
    }
  });

  it("builds If, Buttons, Menu, Repeat and a Form from children lists", () => {
    const result = check(
      raw([
        env("step1", "form", { title: "Tell us", inputs: [{ id: "why", label: "Why?", style: "short", required: true, placeholder: "", minLength: null, maxLength: null }] }),
        env("step2", "if", { branches: [{ match: "all", conditions: [{ type: "compare", left: "{form.why}", op: "eq", right: "yes" }], steps: [] }], else: [] }, [
          { list: "b0", steps: [reply("step3", "Yes then")] },
          { list: "else", steps: [reply("step4", "No then")] },
        ]),
        env("step5", "buttons", { message: { format: "text", content: "Again?" }, buttons: [{ id: "b1", label: "Go", style: "primary", emoji: "", steps: [] }] }, [{ list: "btn:b1", steps: [reply("step6", "Pressed")] }]),
        env("step7", "select_menu", { message: { format: "text", content: "Pick" }, options: [{ id: "o1", label: "One", description: "", emoji: "", steps: [] }] }, [{ list: "opt:o1", steps: [reply("step8", "One")] }]),
        env("step9", "repeat", { times: 2 }, [{ list: "steps", steps: [reply("step10", "Again {loop.index}")] }]),
      ]),
    );
    assert.equal(result.ok, true, JSON.stringify(!result.ok && result.issues));
    if (!result.ok) return;
    const ifStep = result.program.steps[1]!;
    assert.equal(((ifStep.config.branches as { steps: unknown[] }[])[0]!.steps as { id: string }[])[0]!.id, "step3");
    assert.equal((ifStep.config.else as { id: string }[])[0]!.id, "step4");
    assert.equal(((result.program.steps[2]!.config.buttons as { steps: { id: string }[] }[])[0]!.steps[0]!).id, "step6");
  });

  it("reports bad JSON settings and unknown child lists instead of guessing", () => {
    const bad = { ...reply("step1", "x"), config_json: "{not json" };
    const r1 = check(raw([bad]));
    assert.equal(r1.ok, false);
    assert.ok(!r1.ok && r1.issues.some((i) => /valid JSON/.test(i.message)));
    const r2 = check(raw([env("step1", "repeat", { times: 2 }, [{ list: "b0", steps: [reply("step2", "x")] }])]));
    assert.ok(!r2.ok && r2.issues.some((i) => /isn't one of this step's step lists/.test(i.message)));
  });
});

// ── Limits and names ────────────────────────────────────────────────────────────────────────

describe("limits on a draft", () => {
  it("refuses Repeat over its cap, too many options, too deep nesting and too many steps", () => {
    const repeat = check(raw([env("step1", "repeat", { times: LIMITS.repeatTimes + 5 }, [{ list: "steps", steps: [reply("step2", "x")] }])]));
    assert.equal(repeat.ok, false);

    const options = Array.from({ length: LIMITS.options + 1 }, (_, i) => ({ name: `o${i}`, description: "x", type: "text", required: false, minLength: null, maxLength: null, min: null, max: null, channelTypes: null, choices: null, autocomplete: null }));
    assert.equal(check(raw([reply("step1", "x")], { options })).ok, false);

    let nested: unknown = reply("leaf", "x");
    for (let d = 0; d <= LIMITS.depth + 1; d += 1) nested = env(`r${d}`, "repeat", { times: 1 }, [{ list: "steps", steps: [nested] }]);
    assert.equal(check(raw([nested])).ok, false);

    const many = Array.from({ length: LIMITS.totalSteps + 1 }, (_, i) => reply(`step${i + 1}`, "x"));
    assert.equal(check(raw(many)).ok, false);
  });

  it("refuses a form that isn't first and duplicate step ids", () => {
    const form = env("step2", "form", { title: "T", inputs: [{ id: "a", label: "A", style: "short", required: true, placeholder: "", minLength: null, maxLength: null }] });
    assert.equal(check(raw([reply("step1", "x"), form])).ok, false);
    assert.equal(check(raw([reply("step1", "x"), reply("step1", "y")])).ok, false);
  });

  it("picks a free name when the suggested one is taken, and keeps the name while refining", () => {
    const taken = check(raw([reply("step1", "x")]), PermissionFlagsBits.Administrator, { taken: new Set(["hello"]) });
    assert.ok(taken.ok && taken.name === "hello-2");
    const reserved = check(raw([reply("step1", "x")], { name: "help" }));
    assert.ok(reserved.ok && reserved.name === "help-2");
    const kept = check(raw([reply("step1", "x")], { name: "renamed" }), PermissionFlagsBits.Administrator, { keepName: "original" });
    assert.ok(kept.ok && kept.name === "original");
    assert.equal(check(raw([reply("step1", "x")], { name: "Not Valid!" })).ok, false);
  });
});

// ── Builder permissions ─────────────────────────────────────────────────────────────────────

describe("steps the builder couldn't save", () => {
  it("leaves them out of the model's choices", () => {
    const manageOnly = dc.allowedActionTypes(ALL_ON, actor(PermissionFlagsBits.ManageGuild));
    assert.ok(manageOnly.includes("reply"));
    assert.ok(!manageOnly.includes("add_role"));
    assert.ok(!manageOnly.includes("ban"));
    const admin = dc.allowedActionTypes(ALL_ON, { ...actor(0n), administrator: true });
    assert.equal(admin.length, ACTIONS.length);
  });

  it("leaves out steps whose plugin is off", () => {
    const pluginStep = ACTIONS.find((a) => a.plugin);
    assert.ok(pluginStep);
    const off = dc.allowedActionTypes({ plugins: { [pluginStep.plugin!]: { enabled: false } } }, { ...actor(0n), administrator: true });
    assert.ok(!off.includes(pluginStep.type));
  });

  it("refuses a draft with a step needing permissions the builder lacks", () => {
    const addRole = raw([env("step1", "add_role", { role: R_MEMBER, target: "{user.id}" })]);
    const refused = check(addRole, PermissionFlagsBits.ManageGuild);
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.issues.some((i) => /isn't available to you/.test(i.message)));
    assert.equal(check(addRole, PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles).ok, true);
  });

  it("refuses settings that need more than the step's defaults (pinging @everyone)", () => {
    const ping = raw([env("step1", "reply", { message: { format: "text", content: "@everyone hi", pings: { runner: false, optionUsers: false, roles: [], everyone: true } } })]);
    const refused = check(ping, PermissionFlagsBits.ManageGuild);
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.missing.includes("Mention Everyone"));
  });

  it("refuses ids from another server", () => {
    const foreign = check(raw([env("step1", "send_message", { channel: "400000000000000099", message: { format: "text", content: "x" } })]));
    assert.equal(foreign.ok, false);
  });
});

// ── Schema ──────────────────────────────────────────────────────────────────────────────────

describe("structured-output schema", () => {
  const ctx = {
    guildName: "Test",
    voiceChannels: [],
    textChannels: [{ id: CH, name: "general" }],
    categories: [],
    roles: [{ id: R_MEMBER, name: "Member" }],
    emojis: [],
  };

  it("is strict everywhere: every object lists all its keys as required and allows no others", () => {
    const schema = dc.buildDreamCommandSchema(ctx, ["reply", "if"]);
    let enums = 0;
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      const n = node as Record<string, unknown>;
      if (Array.isArray(n.enum)) enums += n.enum.length;
      if (n.type === "object" && n.properties) {
        assert.equal(n.additionalProperties, false);
        assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties as object).sort());
      }
      Object.values(n).forEach(visit);
    };
    visit(schema);
    assert.ok(enums < 1000, `${enums} enum values`);
    const defs = schema.$defs as Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }>;
    assert.deepEqual(defs.step!.properties!.type!.enum, ["reply", "if"]);
    assert.deepEqual(defs.role_id!.enum, [R_MEMBER]);
  });

  it("falls back to plain strings when a server has more ids than the enum budget", () => {
    const big = { ...ctx, roles: Array.from({ length: 900 }, (_, i) => ({ id: String(300000000000000000n + BigInt(i)), name: `r${i}` })) };
    const defs = dc.buildDreamCommandSchema(big, ["reply"]).$defs as Record<string, { enum?: string[] }>;
    assert.equal(defs.role_id!.enum, undefined);
  });

  it("the prompt lists only allowed steps and names the rest as unavailable", () => {
    const prompt = dc.buildDreamCommandPrompt({ ctx, allowedTypes: ["reply"], questionsAsked: 0, current: null, takenNames: ["roll"] });
    assert.match(prompt, /- reply: /);
    assert.doesNotMatch(prompt, /- ban: /);
    assert.match(prompt, /Not available to this user[^\n]*\bban\b/);
    assert.match(prompt, /roll/);
  });

  it("shows a draft being refined in the answer format, and survives a half-built one", () => {
    const t = TEMPLATES[0]!;
    const prompt = dc.buildDreamCommandPrompt({ ctx, allowedTypes: ["reply"], questionsAsked: 0, current: { name: t.commandName, program: t.program }, takenNames: [] });
    assert.match(prompt, /Current command:/);
    assert.match(prompt, /config_json/);
    const broken = dc.buildDreamCommandPrompt({ ctx, allowedTypes: ["reply"], questionsAsked: 0, current: { name: "x", program: { steps: [{ id: "step1", type: "if" }] } }, takenNames: [] });
    assert.match(broken, /Current command:/);
  });
});

// ── Gate ────────────────────────────────────────────────────────────────────────────────────

describe("runDreamCommandAutopilot gate", () => {
  it("doesn't spend a use on a request with no description", async () => {
    const guildId = "100000000000000011";
    const result = await runDreamCommandAutopilot(makeGuild(PermissionFlagsBits.Administrator, guildId), guildId, BUILDER, { answer: "  " });
    assert.equal(result.ok, false);
    assert.equal((await getAiGateStatus(guildId)).freeUsesRemaining, AI_FREE_USES_LIMIT);
  });

  it("doesn't spend a use when the member can't be confirmed", async () => {
    const guildId = "100000000000000012";
    const result = await runDreamCommandAutopilot(makeGuild(PermissionFlagsBits.Administrator, guildId), guildId, "299999999999999999", { answer: "a dice command" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.code === "actor_unresolved");
    assert.equal((await getAiGateStatus(guildId)).freeUsesRemaining, AI_FREE_USES_LIMIT);
  });

  it("charges one use for a generation and gives it back when Autopilot fails", async () => {
    const guildId = "100000000000000013";
    const result = await runDreamCommandAutopilot(makeGuild(PermissionFlagsBits.Administrator, guildId), guildId, BUILDER, { answer: "a dice command" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.status === 502);
    assert.equal((await getAiGateStatus(guildId)).freeUsesRemaining, AI_FREE_USES_LIMIT);
  });

  it("refuses once the free uses are gone (Dreamliner One required)", async () => {
    const guildId = "100000000000000015";
    const { consumeAiGate } = await import("./gate.js");
    for (let i = 0; i < AI_FREE_USES_LIMIT; i += 1) await consumeAiGate(guildId);
    const result = await runDreamCommandAutopilot(makeGuild(PermissionFlagsBits.Administrator, guildId), guildId, BUILDER, { answer: "a dice command" });
    assert.ok(!result.ok && result.status === 403 && result.freeUsesRemaining === 0);
  });

  it("rejects a refine request whose draft is too big, before any charge", async () => {
    const guildId = "100000000000000014";
    const huge = { name: "x", program: { description: "x".repeat(LIMITS.programBytes + 10) } };
    const result = await runDreamCommandAutopilot(makeGuild(PermissionFlagsBits.Administrator, guildId), guildId, BUILDER, { answer: "shorter", current: huge });
    assert.ok(!result.ok && result.status === 400);
    assert.equal((await getAiGateStatus(guildId)).freeUsesRemaining, AI_FREE_USES_LIMIT);
  });
});
