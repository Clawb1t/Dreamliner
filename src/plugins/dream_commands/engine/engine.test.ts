/**
 * Custom Commands v3: validation, interpolation and mention escaping, the interpreter (if/else,
 * repeat caps, step cap, time budget, stop, continue-on-error, seeded random branches), the
 * builder-permission model, cooldowns, follow-up expiry, creation/API caps, foreign-id refusal,
 * runner permission for moderation, safe pattern matching, anti-mint, templates, and the 0153
 * migration of old programs.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { PermissionFlagsBits } from "discord.js";

const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-cc-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();
const { getDb } = await import("../../../db/client.js");
const { validateProgram } = await import("./validate.js");
const { interpolate, newVarStore, setVar, escapeForMessage } = await import("./vars.js");
const { renderMessage } = await import("./message.js");
const { emptyMessageSpec } = await import("./fields.js");
const { execute } = await import("./interpreter.js");
const { ACTION_MAP, ACTIONS } = await import("./registry.js");
const { builderReport, checkGuildIds, collectRequirements } = await import("./permissions.js");
const { cooldownRemaining, startCooldown, clearCooldownsForTests, countCreation } = await import("./limits.js");
const { resolveChannel, resolveRole, spendApi, StepError } = await import("./runtime.js");
const { globMatch, compare } = await import("./conditions.js");
const state = await import("./state.js");
const { TEMPLATES } = await import("./templates.js");
const { upgradeLegacyProgram } = await import("./legacy.js");
const { prepareBuilder } = await import("../functions/run.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

// ── Fakes ───────────────────────────────────────────────────────────────────────────────────

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000002";
const OWNER = "200000000000000001";
const BUILDER = "200000000000000002";
const RUNNER = "200000000000000003";
const TARGET = "200000000000000004";
const BOT = "200000000000000009";
const R_MEMBER = "300000000000000001";
const R_ADMIN = "300000000000000002";
const CH = "400000000000000001";
const FOREIGN_CH = "400000000000000099";
const FOREIGN_ROLE = "300000000000000099";

type FakeRole = { id: string; name: string; position: number; managed: boolean; permissions: { bitfield: bigint } };
const role = (id: string, name: string, position: number, perms = 0n): FakeRole => ({ id, name, position, managed: false, permissions: { bitfield: perms } });

function makeGuild(builderPerms: bigint, builderTop = 5, runnerPerms = 0n) {
  const roles = new Map<string, FakeRole>([
    [GUILD, role(GUILD, "@everyone", 0)],
    [R_MEMBER, role(R_MEMBER, "Member", 2)],
    [R_ADMIN, role(R_ADMIN, "Admin", 10, PermissionFlagsBits.Administrator)],
  ]);
  const guild: Record<string, unknown> = { id: GUILD, ownerId: OWNER, name: "Test", roles: { cache: roles }, emojis: { cache: new Map() } };
  const member = (id: string, perms: bigint, top: number, username: string) => ({
    id,
    guild,
    displayName: username,
    user: { id, username, bot: false, createdTimestamp: Date.now() - 86400_000 * 400 },
    permissions: { bitfield: perms, has: (flag: bigint) => (perms & PermissionFlagsBits.Administrator) !== 0n || (perms & flag) === flag },
    roles: { highest: { position: top }, cache: new Map<string, FakeRole>() },
    voice: {},
  });
  const members = new Map<string, ReturnType<typeof member>>([
    [BUILDER, member(BUILDER, builderPerms, builderTop, "builder")],
    [RUNNER, member(RUNNER, runnerPerms, 1, "runner")],
    [TARGET, member(TARGET, 0n, 1, "target")],
  ]);
  const me = member(BOT, PermissionFlagsBits.Administrator, 50, "Dreamliner");
  guild.members = { cache: members, me, fetch: async (id: string) => members.get(id) ?? Promise.reject(new Error("unknown")) };
  guild.channels = { cache: new Map([[CH, { id: CH, name: "general", type: 0, guildId: GUILD, parentId: null, isTextBased: () => true, isThread: () => false }]]) };
  guild.bans = { fetch: async () => null };
  return { guild: guild as never, members, me };
}

const fakeClient = {
  user: { id: BOT, username: "Dreamliner" },
  channels: { cache: new Map([[FOREIGN_CH, { id: FOREIGN_CH, guildId: OTHER_GUILD, name: "elsewhere" }]]), fetch: async () => null },
} as never;

type Sent = { payload: unknown; ephemeral: boolean };
function fakeResponder() {
  const sent: Sent[] = [];
  return {
    sent,
    responder: {
      acknowledged: true,
      canShowModal: false,
      defer: async () => {},
      send: async (payload: unknown, ephemeral: boolean) => {
        sent.push({ payload, ephemeral });
        return { id: `5000000000000000${sent.length}`, channelId: CH } as never;
      },
      editFirst: async () => null,
      showModal: async () => {},
      fail: async () => {},
      finish: async () => {},
      token: () => null,
    },
  };
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function baseProgram(steps: unknown[], extra: Record<string, unknown> = {}) {
  return { version: 3, description: "Test", ephemeral: false, options: [], steps, ...extra };
}

function makeCtx(program: unknown, opts: { builderPerms?: bigint; runnerPerms?: bigint; rng?: () => number; deadline?: number } = {}) {
  const v = validateProgram(program);
  assert.ok(v.program, JSON.stringify(v.issues));
  const { guild, members } = makeGuild(opts.builderPerms ?? PermissionFlagsBits.Administrator, 5, opts.runnerPerms ?? 0n);
  const { responder, sent } = fakeResponder();
  const ctx = {
    client: fakeClient,
    guild,
    guildConfig: { plugins: {} } as never,
    commandName: "test",
    program: v.program,
    builder: { userId: BUILDER, owner: false, administrator: false, superuser: false, permissions: opts.builderPerms ?? PermissionFlagsBits.Administrator, highestPosition: 5 },
    builderId: BUILDER,
    builderMember: members.get(BUILDER) as never,
    runner: members.get(RUNNER) as never,
    channelId: CH,
    vars: newVarStore(),
    responder,
    counters: { steps: 0, api: 0, creations: 0, dms: 0, waitedSeconds: 0 },
    created: { channels: new Set<string>(), roles: new Set<string>() },
    messages: new Map(),
    optionUserIds: new Set<string>([TARGET]),
    trigger: "slash" as const,
    startedAt: Date.now(),
    deadline: opts.deadline ?? Date.now() + 25_000,
    rng: opts.rng ?? Math.random,
  };
  return { ctx: ctx as never as Parameters<typeof execute>[0], sent };
}

const reply = (id: string, content: string, ephemeral = "default") => ({ id, type: "reply", config: { ephemeral, message: emptyMessageSpec(content) } });
const setv = (id: string, name: string, value: string, valueType = "text") => ({ id, type: "set_variable", config: { name, value, valueType } });
const ROOT = () => [{ block: null, key: "root", index: 0 }];

// ── Validation ──────────────────────────────────────────────────────────────────────────────

describe("program validation", () => {
  it("accepts a minimal reply command and fills defaults", () => {
    const v = validateProgram(baseProgram([{ id: "step1", type: "reply", config: { message: emptyMessageSpec("hi") } }]));
    assert.equal(v.ok, true, JSON.stringify(v.issues));
    assert.equal((v.program!.steps[0]!.config as { ephemeral: string }).ephemeral, "default");
    assert.deepEqual(v.program!.cooldowns, { user: 0, channel: 0, global: 0 });
  });

  it("rejects unknown step types and unknown settings", () => {
    const v = validateProgram(baseProgram([{ id: "step1", type: "nuke_server", config: {} }]));
    assert.equal(v.ok, false);
    assert.match(v.issues[0]!.message, /Unknown step type/);
    const v2 = validateProgram(baseProgram([{ id: "step1", type: "reply", config: { message: emptyMessageSpec("x"), sneaky: true } }]));
    assert.equal(v2.ok, false);
    assert.ok(v2.issues.some((i) => /Unknown setting/.test(i.message)));
  });

  it("rejects oversized programs", () => {
    const big = baseProgram(Array.from({ length: 40 }, (_, i) => reply(`step${i + 1}`, "x".repeat(1990))));
    const v = validateProgram(big);
    assert.equal(v.ok, false);
    assert.match(v.issues[0]!.message, /too big/);
  });

  it("every action's defaults pass its strict schema (catalog stays valid)", () => {
    for (const def of ACTIONS) {
      if (def.block === "form") continue;
      const v = validateProgram(baseProgram([{ id: "step1", type: def.type, config: {} }]));
      const schemaIssues = v.issues.filter((i) => /Unknown setting|Expected|Pick one of the choices/.test(i.message));
      assert.deepEqual(schemaIssues, [], `${def.type}: ${JSON.stringify(schemaIssues)}`);
    }
  });

  it("forms must be first (or first in a button)", () => {
    const form = { id: "step2", type: "form", config: {} };
    assert.equal(validateProgram(baseProgram([form, reply("step3", "ok")])).issues.filter((i) => i.stepId === "step2").length, 0);
    const late = validateProgram(baseProgram([reply("step1", "hi"), form]));
    assert.ok(late.issues.some((i) => i.stepId === "step2" && /first step/.test(i.message)));
  });

  it("moderation steps only target a user option; DMs only the runner or an option", () => {
    const opts = [{ name: "user", description: "Who", type: "member", required: true }];
    const ok = validateProgram(baseProgram([{ id: "step1", type: "ban", config: { target: "{option.user.id}" } }], { options: opts }));
    assert.equal(ok.issues.filter((i) => i.stepId === "step1").length, 0, JSON.stringify(ok.issues));
    const bad = validateProgram(baseProgram([{ id: "step1", type: "ban", config: { target: "{var.someone}" } }], { options: opts }));
    assert.ok(bad.issues.some((i) => /user option/.test(i.message)));
    const dm = validateProgram(baseProgram([{ id: "step1", type: "send_dm", config: { target: "{var.x}", message: emptyMessageSpec("hi") } }]));
    assert.ok(dm.issues.some((i) => /DMs can only go/.test(i.message)));
    const rawId = validateProgram(baseProgram([{ id: "step1", type: "add_role", config: { role: R_MEMBER, target: TARGET } }]));
    assert.ok(rawId.issues.some((i) => /Pick who this is for/.test(i.message)), "typed user ids are refused");
  });

  it("target variables must be typed entities, never free text", () => {
    const opts = [{ name: "text", description: "Text", type: "text", required: true }, { name: "r", description: "Role", type: "role", required: true }];
    const bad = validateProgram(baseProgram([{ id: "step1", type: "add_role", config: { role: "{option.text}", target: "{user.id}" } }, { id: "step2", type: "add_role", config: { role: "{var.x}", target: "{user.id}" } }], { options: opts }));
    assert.ok(bad.issues.some((i) => i.stepId === "step1"));
    assert.ok(bad.issues.some((i) => i.stepId === "step2"));
    const good = validateProgram(baseProgram([{ id: "step1", type: "add_role", config: { role: "{option.r.id}", target: "{user.id}" } }, { id: "step2", type: "create_role", config: {} }, { id: "step3", type: "add_role", config: { role: "{step2.role.id}", target: "{user.id}" } }], { options: opts }));
    assert.deepEqual(good.issues, []);
  });

  it("delete channel only accepts a channel created earlier in the run", () => {
    const bad = validateProgram(baseProgram([{ id: "step1", type: "delete_channel", config: { channel: CH } }]));
    assert.ok(bad.issues.some((i) => /earlier Create channel/.test(i.message)));
    const good = validateProgram(baseProgram([{ id: "step1", type: "create_channel", config: {} }, { id: "step2", type: "delete_channel", config: { channel: "{step1.channel.id}" } }]));
    assert.equal(good.issues.filter((i) => i.stepId === "step2").length, 0, JSON.stringify(good.issues));
  });

  it("created roles can never carry Administrator", () => {
    const v = validateProgram(baseProgram([{ id: "step1", type: "create_role", config: { permissions: ["Administrator"] } }]));
    assert.ok(v.issues.some((i) => /can't be given/.test(i.message)));
  });

  it("templates are valid apart from the pickers left for the builder", () => {
    for (const t of TEMPLATES) {
      const v = validateProgram(t.program);
      const real = v.issues.filter((i) => !/is required/.test(i.message));
      assert.deepEqual(real, [], `${t.id}: ${JSON.stringify(real)}`);
    }
  });
});

// ── Interpolation and mentions ──────────────────────────────────────────────────────────────

describe("variables and mention escaping", () => {
  it("escapes person-provided values, keeps trusted mentions", () => {
    const vars = newVarStore();
    setVar(vars, "option.text", "@everyone look [free nitro](https://evil.example) <@&123456789012345678>");
    setVar(vars, "user.mention", "<@200000000000000003>", true);
    const out = interpolate("{user.mention} said: {option.text}", vars, { mode: "message" });
    assert.ok(out.startsWith("<@200000000000000003> said: "));
    assert.ok(!out.includes("@everyone"));
    assert.ok(out.includes("\\[free nitro\\]"));
    assert.ok(!out.includes("<@&1"));
    assert.equal(escapeForMessage("@here"), "@​here");
  });

  it("strips control characters and supports fallbacks and dynamic tokens", () => {
    const vars = newVarStore();
    setVar(vars, "option.x", "a\u0007b‮c");
    assert.equal(interpolate("{option.x}", vars, { mode: "raw" }), "abc");
    assert.equal(interpolate("{option.missing|none}", vars, { mode: "raw" }), "none");
    assert.equal(interpolate("{random:5-5}", vars, { mode: "raw" }), "5");
    assert.equal(interpolate("{not a token} {unknownroot}", vars, { mode: "raw" }), "{not a token} {unknownroot}");
  });

  it("allowedMentions default to nothing and widen only as configured", () => {
    const vars = newVarStore();
    const spec = emptyMessageSpec("@everyone <@200000000000000004>");
    const none = renderMessage(spec, { vars, rng: Math.random, runnerId: RUNNER, optionUserIds: [TARGET] });
    assert.deepEqual(none.allowedMentions, { parse: [] });
    const some = renderMessage({ ...spec, pings: { runner: true, optionUsers: true, roles: [R_MEMBER], everyone: false } }, { vars, rng: Math.random, runnerId: RUNNER, optionUserIds: [TARGET] });
    assert.deepEqual(some.allowedMentions, { parse: [], users: [RUNNER, TARGET], roles: [R_MEMBER] });
  });

  it("drops non-http links in embeds", () => {
    const spec = emptyMessageSpec();
    spec.format = "embed";
    spec.embed.title = "t";
    spec.embed.imageUrl = "javascript:alert(1)";
    spec.embed.thumbnailUrl = "https://ok.example/a.png";
    const out = renderMessage(spec, { vars: newVarStore(), rng: Math.random, runnerId: RUNNER, optionUserIds: [] });
    const embed = (out.embeds as Record<string, unknown>[])[0]!;
    assert.equal(embed.image, undefined);
    assert.deepEqual(embed.thumbnail, { url: "https://ok.example/a.png" });
  });

  it("member-required role pings need Mention Everyone from the builder", () => {
    const spec = { ...emptyMessageSpec("hi"), pings: { runner: false, optionUsers: false, roles: [R_MEMBER], everyone: false } };
    const v = validateProgram(baseProgram([{ id: "step1", type: "reply", config: { message: spec } }]));
    const req = collectRequirements(v.program!);
    assert.ok(req.builder.includes("MentionEveryone"));
  });
});

// ── Interpreter ─────────────────────────────────────────────────────────────────────────────

describe("interpreter", () => {
  it("runs if / else if / else", async () => {
    const program = baseProgram([
      setv("step1", "n", "7", "number"),
      {
        id: "step2",
        type: "if",
        config: {
          branches: [
            { match: "all", conditions: [{ type: "compare", left: "{var.n}", op: "gt", right: "10" }], steps: [reply("step3", "big")] },
            { match: "all", conditions: [{ type: "compare", left: "{var.n}", op: "gt", right: "5" }], steps: [reply("step4", "medium")] },
          ],
          else: [reply("step5", "small")],
        },
      },
    ]);
    const { ctx, sent } = makeCtx(program);
    const outcome = await execute(ctx, ROOT() as never);
    assert.equal(outcome.status, "ok");
    assert.equal(sent.length, 1);
    assert.equal((sent[0]!.payload as { content: string }).content, "medium");
  });

  it("caps repeats and the executed-step count", async () => {
    const tooMany = validateProgram(baseProgram([{ id: "step1", type: "repeat", config: { times: 50, steps: [] } }]));
    assert.equal(tooMany.ok, false);
    const nested = baseProgram([
      { id: "step1", type: "repeat", config: { times: 10, steps: [{ id: "step2", type: "repeat", config: { times: 10, steps: [setv("step3", "x", "1")] } }] } },
    ]);
    const { ctx } = makeCtx(nested);
    const outcome = await execute(ctx, ROOT() as never);
    assert.equal(outcome.status, "error");
    assert.match((outcome as { error: string }).error, /more than 50 steps/);
  });

  it("stops at the time budget", async () => {
    const { ctx } = makeCtx(baseProgram([setv("step1", "x", "1")]), { deadline: Date.now() - 1 });
    const outcome = await execute(ctx, ROOT() as never);
    assert.equal(outcome.status, "error");
    assert.match((outcome as { error: string }).error, /took too long/);
  });

  it("stop ends the run and later steps don't run", async () => {
    const { ctx, sent } = makeCtx(baseProgram([{ id: "step1", type: "stop", config: { message: "Bye {user.mention}", asError: false } }, reply("step2", "never")]));
    setVar(ctx.vars, "user.mention", `<@${RUNNER}>`, true);
    const outcome = await execute(ctx, ROOT() as never);
    assert.equal(outcome.status, "stopped");
    assert.equal((outcome as { message: string }).message, `Bye <@${RUNNER}>`);
    assert.equal(sent.length, 0);
  });

  it("continue on error records the failure and carries on; otherwise the run stops", async () => {
    const div = (cont: boolean) => ({ id: "step1", type: "math", continueOnError: cont, config: { operation: "divide", a: "1", b: "0", name: "" } });
    const a = makeCtx(baseProgram([div(true), reply("step2", "after {step1.error}")]));
    const outA = await execute(a.ctx, ROOT() as never);
    assert.equal(outA.status, "ok");
    assert.match((a.sent[0]!.payload as { content: string }).content, /divide by zero/);
    const b = makeCtx(baseProgram([div(false), reply("step2", "after")]));
    const outB = await execute(b.ctx, ROOT() as never);
    assert.equal(outB.status, "error");
    assert.equal((outB as { stepId: string }).stepId, "step1");
    assert.equal(b.sent.length, 0);
  });

  it("random branches follow the (seeded) rng and weights", async () => {
    const program = baseProgram([{ id: "step1", type: "random_branch", config: { branches: [{ weight: 0, steps: [reply("step2", "never")] }, { weight: 1, steps: [reply("step3", "always")] }] } }]);
    for (const seed of [1, 2, 3, 4]) {
      const { ctx, sent } = makeCtx(program, { rng: seeded(seed) });
      await execute(ctx, ROOT() as never);
      assert.equal((sent[0]!.payload as { content: string }).content, "always");
    }
    const even = baseProgram([{ id: "step1", type: "random_branch", config: { branches: [{ weight: 1, steps: [setv("step2", "p", "a")] }, { weight: 1, steps: [setv("step3", "p", "b")] }] } }]);
    const r1 = makeCtx(even, { rng: seeded(42) });
    const r2 = makeCtx(even, { rng: seeded(42) });
    await execute(r1.ctx, ROOT() as never);
    await execute(r2.ctx, ROOT() as never);
    assert.equal(r1.ctx.vars.values.get("var.p"), r2.ctx.vars.values.get("var.p"));
  });

  it("repeat for each sets loop variables", async () => {
    const program = baseProgram([
      setv("step1", "out", ""),
      { id: "step2", type: "repeat_each", config: { source: "list", list: "a, b, c", separator: "comma", limit: 25, steps: [setv("step3", "out", "{var.out}{loop.index}{loop.item}")] } },
    ]);
    const { ctx } = makeCtx(program);
    await execute(ctx, ROOT() as never);
    assert.equal(ctx.vars.values.get("var.out"), "1a2b3c");
  });

  it("caps Discord API calls per run", () => {
    const { ctx } = makeCtx(baseProgram([setv("step1", "x", "1")]));
    for (let i = 0; i < 25; i++) spendApi(ctx);
    assert.throws(() => spendApi(ctx), /too many Discord requests/);
  });
});

// ── Permissions and guild safety ────────────────────────────────────────────────────────────

describe("builder permissions and foreign ids", () => {
  const addRole = (roleId: string) => baseProgram([{ id: "step1", type: "add_role", config: { role: roleId, target: "{user.id}" } }]);

  it("a Manage Server-only builder can't save Add Role; a role above them is refused", () => {
    const { guild } = makeGuild(PermissionFlagsBits.ManageGuild);
    const actor = { userId: BUILDER, owner: false, administrator: false, superuser: false, permissions: PermissionFlagsBits.ManageGuild, highestPosition: 5 };
    const program = validateProgram(addRole(R_ADMIN)).program!;
    const report = builderReport(guild, actor, collectRequirements(program));
    assert.ok(report.missing.includes("Manage Roles"));
    const withRoles = { ...actor, permissions: PermissionFlagsBits.ManageRoles };
    const report2 = builderReport(guild, withRoles, collectRequirements(program));
    assert.deepEqual(report2.missing, []);
    assert.ok(report2.problems.some((p) => /above your highest role|permissions you don't have/.test(p.message)));
    const fine = builderReport(guild, withRoles, collectRequirements(validateProgram(addRole(R_MEMBER)).program!));
    assert.deepEqual(fine, { missing: [], problems: [] });
  });

  it("a run is refused (and flagged) once the builder lost the permission", async () => {
    const { guild, members } = makeGuild(PermissionFlagsBits.ManageGuild);
    const program = validateProgram(addRole(R_MEMBER)).program!;
    const command = { guildId: GUILD, name: "x", program, createdBy: BUILDER, ownerId: BUILDER, lastEditorId: BUILDER, createdAt: new Date(), updatedAt: new Date(), enabled: true, health: null };
    const prepared = await prepareBuilder(command, members.get(RUNNER) as never);
    assert.equal(prepared.ok, false);
    assert.match((prepared as { message: string }).message, /Manage Roles/);
    const { guild: g2, members: m2 } = makeGuild(PermissionFlagsBits.ManageRoles);
    const ok = await prepareBuilder(command, m2.get(RUNNER) as never);
    assert.equal(ok.ok, true);
    void guild;
    void g2;
  });

  it("a foreign channel or role id is refused at save", () => {
    const { guild } = makeGuild(PermissionFlagsBits.Administrator);
    const program = validateProgram(baseProgram([{ id: "step1", type: "send_message", config: { channel: FOREIGN_CH, message: emptyMessageSpec("x") } }, { id: "step2", type: "add_role", config: { role: FOREIGN_ROLE, target: "{user.id}" } }])).program!;
    const issues = checkGuildIds(guild, program);
    assert.ok(issues.some((i) => i.stepId === "step1" && /isn't in this server/.test(i.message)));
    assert.ok(issues.some((i) => i.stepId === "step2" && /isn't in this server/.test(i.message)));
  });

  it("a foreign id at run time (picked or from a variable) is refused", async () => {
    const { ctx } = makeCtx(baseProgram([setv("step1", "x", "1")]));
    await assert.rejects(() => resolveChannel(ctx, FOREIGN_CH), (e: unknown) => e instanceof StepError && /isn't a channel in this server/.test((e as Error).message));
    setVar(ctx.vars, "var.evil", FOREIGN_ROLE);
    assert.throws(() => resolveRole(ctx, "{var.evil}"), /isn't a role in this server/);
    setVar(ctx.vars, "var.evilch", `<#${FOREIGN_CH}>`);
    await assert.rejects(() => resolveChannel(ctx, "{var.evilch}"), /isn't a channel in this server/);
  });

  it("a runner without Ban Members can't trigger a ban step", async () => {
    const opts = [{ name: "user", description: "Who", type: "member", required: true }];
    const program = baseProgram([{ id: "step1", type: "ban", config: { target: "{option.user.id}" } }], { options: opts });
    const { ctx } = makeCtx(program, { runnerPerms: 0n });
    setVar(ctx.vars, "option.user.id", TARGET, true);
    const outcome = await execute(ctx, ROOT() as never);
    assert.equal(outcome.status, "error");
    assert.match((outcome as { error: string }).error, /You need Ban Members/);
  });
});

// ── Limits ──────────────────────────────────────────────────────────────────────────────────

describe("limits", () => {
  beforeEach(() => clearCooldownsForTests());

  it("cooldowns per user, channel and server", () => {
    const cd = { user: 30, channel: 0, global: 5 };
    const now = 1_000_000;
    assert.equal(cooldownRemaining(GUILD, "c", RUNNER, CH, cd, now), 0);
    startCooldown(GUILD, "c", RUNNER, CH, cd, now);
    assert.equal(cooldownRemaining(GUILD, "c", RUNNER, CH, cd, now + 1000), 29);
    assert.equal(cooldownRemaining(GUILD, "c", TARGET, CH, cd, now + 1000), 4, "server-wide cooldown applies to others");
    assert.equal(cooldownRemaining(GUILD, "c", TARGET, CH, cd, now + 6000), 0);
    assert.equal(cooldownRemaining(OTHER_GUILD, "c", RUNNER, CH, cd, now + 1000), 0, "other servers unaffected");
  });

  it("caps channel/role creation per run and per server per hour", async () => {
    const { ctx } = makeCtx(baseProgram([setv("step1", "x", "1")]));
    await countCreation(ctx, "channel");
    await countCreation(ctx, "channel");
    await countCreation(ctx, "channel");
    await assert.rejects(() => countCreation(ctx, "channel"), /at most 3/);
    const { ctx: ctx2 } = makeCtx(baseProgram([setv("step1", "x", "1")]));
    for (let i = 0; i < 6; i++) {
      const { ctx: c } = makeCtx(baseProgram([setv("step1", "x", "1")]));
      for (let k = 0; k < 3; k++) await countCreation(c, "channel").catch(() => null);
    }
    await assert.rejects(() => countCreation(ctx2, "role"), /last hour/);
  });

  it("follow-ups expire, are scoped to their guild, and single-use is claimed once", () => {
    const st = { kind: "buttons", blockId: "step1", runnerId: RUNNER, channelId: CH, commandUpdatedAt: 0, builderId: BUILDER, continuation: { stack: [], vars: { values: [], trusted: [] }, counters: { steps: 0, api: 0, creations: 0, dms: 0, waitedSeconds: 0 }, created: { channels: [], roles: [] }, messages: [], optionUserIds: [] } } as never;
    const now = Date.now();
    const id = state.saveFollowup(GUILD, "c", st, 60_000, now);
    assert.equal(state.getFollowup(id, GUILD, now + 1000).status, "ok");
    assert.equal(state.getFollowup(id, OTHER_GUILD, now + 1000).status, "missing");
    assert.equal(state.claimFollowup(id, true), true);
    assert.equal(state.claimFollowup(id, true), false);
    assert.equal(state.getFollowup(id, GUILD, now + 61_000).status, "expired");
    assert.equal(state.getFollowup(id, GUILD, now + 62_000).status, "missing");
  });

  it("run history keeps the newest 50 per command", () => {
    for (let i = 0; i < 60; i++) state.recordRun({ guildId: GUILD, commandName: "hist", userId: RUNNER, channelId: CH, trigger: "slash", status: i % 2 ? "ok" : "error", startedAt: new Date(), durationMs: 5, steps: 1, failedStepId: null, error: null });
    assert.equal(state.listRuns(GUILD, "hist", 100).length, 50);
  });
});

// ── Safe matching ───────────────────────────────────────────────────────────────────────────

describe("safe pattern matching", () => {
  it("glob matches and a pathological pattern can't hang", () => {
    assert.equal(globMatch("hello world", "hel*wor?d"), true);
    assert.equal(globMatch("hello", "h?llo*x"), false);
    const start = Date.now();
    assert.equal(globMatch("a".repeat(5000), "*a*a*a*a*a*a*a*a*a*a*a*a*a*b"), false);
    assert.ok(Date.now() - start < 200, "linear-ish time on capped input");
    assert.equal(compare("Hello", "contains", "ell"), true);
    assert.equal(compare("10", "gt", "9"), true);
  });
});

// ── Anti-mint ───────────────────────────────────────────────────────────────────────────────

describe("anti-mint", () => {
  it("no step can create or credit coins", () => {
    for (const def of ACTIONS) assert.doesNotMatch(def.type, /credit|mint|give_coins|add_coins|reward_coins|grant_coins/);
    const dir = join(dirname(fileURLToPath(import.meta.url)), "actions");
    for (const file of readdirSync(dir)) {
      const src = readFileSync(join(dir, file), "utf8");
      assert.doesNotMatch(src, /creditServer|creditGlobal|transferCoins|exchangeServerForGlobal/, file);
    }
    assert.ok(ACTION_MAP.get("economy_charge"));
  });
});

// ── Migration ───────────────────────────────────────────────────────────────────────────────

describe("0153 migration of old programs", () => {
  it("turns each v2 program into one Reply step and keeps name, enabled and ephemeral", () => {
    const Sqlite = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
    const db = new Sqlite(":memory:");
    db.exec(`CREATE TABLE dream_commands (guild_id text NOT NULL, name text NOT NULL, program text NOT NULL, created_by text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, enabled integer DEFAULT 1 NOT NULL, PRIMARY KEY(guild_id, name));`);
    const embedEmpty = { authorName: "", authorIconUrl: "", authorUrl: "", title: "", titleUrl: "", description: "", thumbnailUrl: "", imageUrl: "", color: null, footerText: "", timestamp: false };
    const rows = [
      ["rules", { version: 2, description: "Server rules", ephemeral: true, responseType: "text", random: false, content: "Hi {mention}, read the rules in {channel}", variants: [], embed: embedEmpty }, 1],
      ["fortune", { version: 2, description: "Fortune", ephemeral: false, responseType: "text", random: true, content: "", variants: ["Yes", "No"], embed: embedEmpty }, 0],
      ["card", { version: 2, description: "Card", ephemeral: false, responseType: "embed", random: false, content: "", variants: [], embed: { ...embedEmpty, title: "Welcome {user}", color: 255, timestamp: true } }, 1],
    ] as const;
    const insert = db.prepare("INSERT INTO dream_commands VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const [name, program, enabled] of rows) insert.run(GUILD, name, JSON.stringify(program), BUILDER, 1, 1, enabled);
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../drizzle/migrations/0153_custom_commands_v3.sql"), "utf8");
    db.exec(sql);
    const out = db.prepare("SELECT name, program, enabled, owner_id, last_editor_id FROM dream_commands ORDER BY name").all() as { name: string; program: string; enabled: number; owner_id: string; last_editor_id: string }[];
    assert.equal(out.length, 3);
    for (const row of out) {
      assert.equal(row.owner_id, BUILDER);
      assert.equal(row.last_editor_id, BUILDER);
      const program = JSON.parse(row.program);
      const v = validateProgram(program);
      assert.equal(v.ok, true, `${row.name}: ${JSON.stringify(v.issues)}`);
      assert.equal(program.steps.length, 1);
      assert.equal(program.steps[0].type, "reply");
      // Matches the code path for old shapes.
      const original = rows.find((r) => r[0] === row.name)![1];
      assert.deepEqual(program, upgradeLegacyProgram(original));
    }
    const rules = JSON.parse(out.find((r) => r.name === "rules")!.program);
    assert.equal(rules.ephemeral, true);
    assert.equal(rules.steps[0].config.message.content, "Hi {user.mention}, read the rules in {channel}");
    assert.deepEqual(JSON.parse(out.find((r) => r.name === "fortune")!.program).steps[0].config.message.variants, ["Yes", "No"]);
    assert.equal(out.find((r) => r.name === "fortune")!.enabled, 0);
    const card = JSON.parse(out.find((r) => r.name === "card")!.program).steps[0].config.message;
    assert.equal(card.format, "embed");
    assert.equal(card.embed.title, "Welcome {user}");
    assert.equal(card.embed.timestamp, true);
    db.close();
  });
});
