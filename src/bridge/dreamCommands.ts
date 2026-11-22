/**
 * Custom Commands on the dashboard: list, get, create, update (incl. rename), duplicate, delete,
 * enable/disable, catalog, templates, run history, dry-run test, import/export.
 *
 * Who: Manage Server or the plugin's can_manage flag to use the page. Saving also runs the
 * builder-permission check against the saving user: they must hold every permission the steps
 * need and outrank every role the steps give or edit ("builder's perms, capped"), and every
 * picked id must be one of this guild's roles/channels. Errors carry per-step `issues`.
 */
import type { Client, Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import { hasPermission } from "../core/permissionRoles.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { ACTOR_UNRESOLVED_MESSAGE, resolveActor, type ActorInfo } from "../core/actorPermissions.js";
import { getLogger } from "../core/logger.js";
import {
  countDreamCommands,
  createDreamCommand,
  deleteDreamCommand,
  getDreamCommand,
  listDreamCommands,
  normalizeCommandName,
  updateDreamCommand,
  type DreamCommandRow,
} from "../plugins/dream_commands/functions/store.js";
import { commandCap, getReservedCommandNames, guildHasOne, isRegistered, scheduleGuildSync, selectRegistrable } from "../plugins/dream_commands/functions/guildSlash.js";
import { getDreamCommandsUsage, type DreamCommandUsage } from "../plugins/dream_commands/functions/usage.js";
import { validateProgram, commandNameProblem, type Issue } from "../plugins/dream_commands/engine/validate.js";
import { botReport, builderReport, checkGuildIds, collectRequirements } from "../plugins/dream_commands/engine/permissions.js";
import { buildCatalog } from "../plugins/dream_commands/engine/catalog.js";
import { TEMPLATES } from "../plugins/dream_commands/engine/templates.js";
import { ACTION_MAP } from "../plugins/dream_commands/engine/registry.js";
import { walkSteps } from "../plugins/dream_commands/engine/validate.js";
import * as runState from "../plugins/dream_commands/engine/state.js";
import type { CommandProgram } from "../plugins/dream_commands/engine/types.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import { trackDashboardAction } from "./dashboardAudit.js";
const log = getLogger("bridge");

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const bad = (error: string, status = 400, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, ...extra } });

export type CommandsRequest = {
  client: Client;
  guild: Guild;
  userId: string;
  method: string;
  subPath: string;
  readJson: () => Promise<Record<string, unknown> | null>;
  managesServer: boolean;
};

type WebPerson = { id: string; name: string; username: string | null; avatar: string | null };

async function person(guild: Guild, userId: string): Promise<WebPerson | null> {
  if (!/^\d{15,22}$/.test(userId)) return null;
  const member = await fetchMemberCached(guild, userId);
  const user = member?.user ?? (await fetchUserCached(guild.client, userId));
  return { id: userId, name: member?.displayName ?? user?.globalName ?? user?.username ?? userId, username: user?.username ?? null, avatar: user?.displayAvatarURL({ size: 64 }) ?? null };
}

export async function canManageCommands(guild: Guild, userId: string, managesServer: boolean): Promise<boolean> {
  if (managesServer) return true;
  try {
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
    return await hasPermission(guild.id, "dream_commands", "can_manage", member, await configManager.getEffectiveConfig(guild.id));
  } catch {
    return false;
  }
}

function countSteps(program: CommandProgram): number {
  let n = 0;
  walkSteps(program.steps, () => {
    n += 1;
  });
  return n;
}

const NO_USAGE: DreamCommandUsage = { total: 0, last7d: 0, last30d: 0, lastUsedDate: null };

async function rows(guild: Guild, commands: DreamCommandRow[], withProgram: boolean) {
  const usage = await getDreamCommandsUsage(guild.id, commands.map((c) => c.name)).catch(() => null);
  const runs = runState.summarizeRuns(guild.id);
  const oneActive = await guildHasOne(guild.id);
  const cap = commandCap(oneActive);
  const registrable = new Set(selectRegistrable(commands.filter((c) => c.enabled), cap).map((c) => c.name));
  const ids = [...new Set(commands.flatMap((c) => [c.ownerId, c.lastEditorId]))];
  const people = new Map((await Promise.all(ids.map(async (id) => [id, await person(guild, id).catch(() => null)] as const))).filter(([, p]) => p));
  return {
    usage,
    oneActive,
    cap,
    rows: commands.map((c) => {
      const r = runs.get(c.name);
      let health: { status: string; message: string | null; missing: string[] } = { status: "ok", message: null, missing: [] };
      if (c.health) health = { status: "needs_resave", message: c.health.message, missing: c.health.missing };
      else if (c.enabled && !registrable.has(c.name)) health = { status: "over_cap", message: `Over this server's limit of ${cap} commands, so it isn't in Discord.`, missing: [] };
      else if (r?.last?.status === "error") health = { status: "failing", message: r.last.error, missing: [] };
      return {
        name: c.name,
        description: c.program.description,
        enabled: c.enabled,
        stepCount: countSteps(c.program),
        optionCount: c.program.options.length,
        usage: usage?.byName[c.name] ?? NO_USAGE,
        runs30d: r?.runs30d ?? 0,
        failures30d: r?.failures30d ?? 0,
        lastRun: r?.last ? { at: r.last.at.toISOString(), status: r.last.status, error: r.last.error } : null,
        health,
        registered: isRegistered(guild.id, c.name),
        owner: people.get(c.ownerId) ?? null,
        lastEditor: people.get(c.lastEditorId) ?? null,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        ...(withProgram ? { program: c.program } : {}),
      };
    }),
  };
}

async function oneCommand(guild: Guild, command: DreamCommandRow) {
  const result = await rows(guild, [command], true);
  return result.rows[0]!;
}

type SaveCheck = { ok: true; program: CommandProgram; actor: ActorInfo } | { ok: false; reply: Reply };

/** Validation + guild id check + the builder-permission check against the saving user. */
async function checkSave(guild: Guild, userId: string, input: unknown): Promise<SaveCheck> {
  const validated = validateProgram(input);
  if (!validated.ok || !validated.program) {
    return { ok: false, reply: bad(validated.issues[0]?.message ?? "The command isn't valid.", 400, { issues: validated.issues }) };
  }
  const program = validated.program;
  const idIssues = checkGuildIds(guild, program);
  if (idIssues.length) return { ok: false, reply: bad(idIssues[0]!.message, 400, { issues: idIssues }) };
  const actor = await resolveActor(guild, userId);
  if (!actor) return { ok: false, reply: bad(ACTOR_UNRESOLVED_MESSAGE, 403, { code: "actor_unresolved" }) };
  const report = builderReport(guild, actor, collectRequirements(program));
  if (report.missing.length || report.problems.length) {
    const issues: Issue[] = report.problems.map((p) => ({ path: p.stepId ? `steps.${p.stepId}` : "", stepId: p.stepId, message: p.message }));
    const head = report.missing.length ? `You need ${report.missing.join(", ")} to save this command.` : report.problems[0]!.message;
    return { ok: false, reply: bad(head, 403, { code: "missing_permissions", missing: report.missing, issues }) };
  }
  return { ok: true, program, actor };
}

async function testReport(guild: Guild, userId: string, input: unknown) {
  const validated = validateProgram(input);
  const program = validated.program;
  const issues = [...validated.issues];
  if (!program) return ok({ ok: false, issues, builder: { missing: [], problems: [] }, bot: { missing: [], problems: [] }, plugins: [], requiredPermissions: [], steps: 0, options: 0 });
  issues.push(...checkGuildIds(guild, program));
  const req = collectRequirements(program);
  const actor = await resolveActor(guild, userId);
  const builder = actor ? builderReport(guild, actor, req) : { missing: [], problems: [{ stepId: null, message: ACTOR_UNRESOLVED_MESSAGE }] };
  const bot = botReport(guild, req);
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const plugins = [...req.plugins.entries()].map(([plugin, stepIds]) => {
    const def = [...ACTION_MAP.values()].find((a) => a.plugin === plugin);
    return { plugin, label: def?.pluginLabel ?? plugin, enabled: pluginEnabled(guildConfig, plugin), stepIds };
  });
  const { permissionLabel } = await import("../core/actorPermissions.js");
  const report = {
    ok: !issues.length && !builder.missing.length && !builder.problems.length && !bot.missing.length && !bot.problems.length && plugins.every((p) => p.enabled),
    issues,
    builder,
    bot,
    plugins,
    requiredPermissions: req.builder.map((p) => permissionLabel(p)),
    steps: countSteps(program),
    options: program.options.length,
  };
  return ok(report);
}

async function sync(client: Client, guildId: string): Promise<string | null> {
  try {
    await scheduleGuildSync(client, guildId);
    return null;
  } catch (error) {
    log.error("[bridge] custom command sync failed:", error);
    return "Saved, but Discord didn't accept the command list. Try saving again in a moment.";
  }
}

function track(client: Client, guildId: string, userId: string, title: string, summary: string, name: string): void {
  trackDashboardAction(client, guildId, userId, { eventType: "dashboard_command", title, summary, targetId: name, payload: { name } });
}

async function create(r: CommandsRequest, rawName: unknown, program: unknown, enabled: unknown): Promise<Reply> {
  const name = normalizeCommandName(String(rawName ?? ""));
  const nameProblem = commandNameProblem(name, getReservedCommandNames());
  if (nameProblem) return bad(nameProblem, 400, { issues: [{ path: "name", stepId: null, message: nameProblem }] });
  if (await getDreamCommand(r.guild.id, name)) return bad(`/${name} already exists.`, 409, { issues: [{ path: "name", stepId: null, message: "A command with this name already exists." }] });
  const cap = commandCap(await guildHasOne(r.guild.id));
  if ((await countDreamCommands(r.guild.id)) >= cap) {
    return bad(cap < 100 ? `This server has ${cap} custom commands, the free limit. Dreamliner One raises it to 100.` : `This server has ${cap} custom commands, the most Discord allows.`, 400, { code: "cap" });
  }
  const check = await checkSave(r.guild, r.userId, program);
  if (!check.ok) return check.reply;
  const created = await createDreamCommand({ guildId: r.guild.id, name, program: check.program, createdBy: r.userId, enabled: enabled !== false });
  const syncError = await sync(r.client, r.guild.id);
  track(r.client, r.guild.id, r.userId, "Custom command created", `Custom command \`/${name}\` was created from the dashboard.`, name);
  return ok({ ok: true, command: await oneCommand(r.guild, created), ...(syncError ? { warning: syncError } : {}) });
}

export async function handleCommandsRequest(r: CommandsRequest): Promise<Reply> {
  if (!(await canManageCommands(r.guild, r.userId, r.managesServer))) return bad("You need Manage Server or the Commands manage permission.", 403);
  const parts = r.subPath.split("/").filter(Boolean);
  const m = r.method.toUpperCase();
  const { guild } = r;

  try {
    if (!parts.length) {
      if (m === "GET") {
        const commands = await listDreamCommands(guild.id);
        const result = await rows(guild, commands, false);
        const guildConfig = await configManager.getEffectiveConfig(guild.id);
        return ok({
          commands: result.rows,
          count: commands.length,
          cap: result.cap,
          freeCap: commandCap(false),
          oneCap: commandCap(true),
          oneActive: result.oneActive,
          usage: result.usage ? { total: result.usage.total, last7d: result.usage.last7d, last30d: result.usage.last30d, daily: result.usage.daily } : { total: 0, last7d: 0, last30d: 0, daily: [] },
          runs30d: result.rows.reduce((s, c) => s + c.runs30d, 0),
          failing: result.rows.filter((c) => c.health.status !== "ok").length,
          pluginEnabled: pluginEnabled(guildConfig, "dream_commands"),
          reservedNames: [...getReservedCommandNames()].sort(),
        });
      }
      if (m === "POST") {
        const body = await r.readJson();
        if (!body) return bad("Invalid JSON body");
        return await create(r, body.name, body.program, body.enabled);
      }
      return bad("Method not allowed", 405);
    }

    const [first, name, action] = parts;

    if (first === "catalog" && parts.length === 1 && m === "GET") {
      const actor = await resolveActor(guild, r.userId);
      return ok(await buildCatalog(guild, await configManager.getEffectiveConfig(guild.id), actor, await guildHasOne(guild.id)));
    }
    if (first === "templates" && parts.length === 1 && m === "GET") return ok({ templates: TEMPLATES });
    if (first === "validate" && parts.length === 1 && m === "POST") {
      const body = await r.readJson();
      if (!body) return bad("Invalid JSON body");
      const report = await testReport(guild, r.userId, body.program);
      const nameIssue = typeof body.name === "string" ? commandNameProblem(normalizeCommandName(body.name), getReservedCommandNames()) : null;
      if (nameIssue) {
        const b = report.body as { ok: boolean; issues: Issue[] };
        b.issues.unshift({ path: "name", stepId: null, message: nameIssue });
        b.ok = false;
      }
      return report;
    }
    if (first === "import" && parts.length === 1 && m === "POST") {
      const body = await r.readJson();
      const data = body?.data as { dreamlinerCommand?: unknown; name?: unknown; program?: unknown } | undefined;
      if (!data || data.dreamlinerCommand !== 1 || typeof data.program !== "object") return bad("That isn't a Dreamliner command export.");
      return await create(r, typeof body?.name === "string" && body.name ? body.name : data.name, data.program, false);
    }

    if (first !== "c" || !name || parts.length > 3) return bad("Not found", 404);
    const command = await getDreamCommand(guild.id, name);
    if (!command) return bad(`No command named /${normalizeCommandName(name)}.`, 404);

    if (!action) {
      if (m === "GET") return ok({ command: await oneCommand(guild, command) });
      if (m === "DELETE") {
        await deleteDreamCommand(guild.id, command.name);
        runState.deleteCommandState(guild.id, command.name);
        const syncError = await sync(r.client, guild.id);
        track(r.client, guild.id, r.userId, "Custom command deleted", `Custom command \`/${command.name}\` was deleted from the dashboard.`, command.name);
        return ok({ ok: true, ...(syncError ? { warning: syncError } : {}) });
      }
      if (m === "PUT") {
        const body = await r.readJson();
        if (!body) return bad("Invalid JSON body");
        const hasProgram = body.program !== undefined;
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") return bad("enabled must be true or false.");
        let rename: string | undefined;
        if (typeof body.name === "string" && normalizeCommandName(body.name) !== command.name) {
          rename = normalizeCommandName(body.name);
          const problem = commandNameProblem(rename, getReservedCommandNames());
          if (problem) return bad(problem, 400, { issues: [{ path: "name", stepId: null, message: problem }] });
          if (await getDreamCommand(guild.id, rename)) return bad(`/${rename} already exists.`, 409, { issues: [{ path: "name", stepId: null, message: "A command with this name already exists." }] });
        }
        // Turning a command on also runs as its builder, so re-check them (the current saver if the program changes).
        let program: CommandProgram | undefined;
        let editorId: string | undefined;
        if (hasProgram) {
          const check = await checkSave(guild, r.userId, body.program);
          if (!check.ok) return check.reply;
          program = check.program;
          editorId = r.userId;
        } else if (body.enabled === true && !command.enabled) {
          const check = await checkSave(guild, r.userId, command.program);
          if (!check.ok) return check.reply;
          editorId = r.userId;
        }
        const updated = await updateDreamCommand(guild.id, command.name, { program, enabled: body.enabled as boolean | undefined, editorId, rename });
        if (!updated) return bad("Not found", 404);
        if (rename) runState.renameRuns(guild.id, command.name, rename);
        const syncError = await sync(r.client, guild.id);
        track(r.client, guild.id, r.userId, "Custom command updated", `Custom command \`/${updated.name}\` was updated from the dashboard.`, updated.name);
        return ok({ ok: true, command: await oneCommand(guild, updated), ...(syncError ? { warning: syncError } : {}) });
      }
      return bad("Method not allowed", 405);
    }

    if (action === "runs" && m === "GET") {
      const runs = runState.listRuns(guild.id, command.name);
      const people = new Map<string, WebPerson | null>();
      for (const id of new Set(runs.map((x) => x.userId)).values()) people.set(id, await person(guild, id).catch(() => null));
      return ok({
        runs: runs.map((x) => ({ id: x.id, at: x.startedAt.toISOString(), user: people.get(x.userId) ?? null, trigger: x.trigger, status: x.status, durationMs: x.durationMs, steps: x.steps, failedStepId: x.failedStepId, error: x.error })),
      });
    }
    if (action === "test" && m === "POST") return await testReport(guild, r.userId, command.program);
    if (action === "export" && m === "GET") return ok({ export: { dreamlinerCommand: 1, name: command.name, program: command.program } });
    if (action === "duplicate" && m === "POST") {
      const taken = new Set((await listDreamCommands(guild.id)).map((c) => c.name));
      let copy = `${command.name.slice(0, 27)}_copy`;
      for (let i = 2; taken.has(copy) && i < 100; i++) copy = `${command.name.slice(0, 26 - String(i).length)}_copy${i}`;
      return await create(r, copy, command.program, false);
    }
    return bad("Not found", 404);
  } catch (error) {
    log.error("[bridge] custom commands request failed:", error);
    return bad("Something went wrong.", 500);
  }
}
