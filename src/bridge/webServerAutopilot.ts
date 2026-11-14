import { PermissionFlagsBits, type Client, type Guild } from "discord.js";
import { AI_ONE_REQUIRED, consumeAiGate } from "../core/ai/gate.js";
import { AI_FREE_USES_LIMIT, getAiGateStatus } from "../core/ai/usage.js";
import { getLogger } from "../core/logger.js";
import { parseAnswers } from "../core/serverAutopilot/answers.js";
import { backupCounts, backupStructureView, parseBackupStructure } from "../core/serverAutopilot/backup.js";
import { createBackup, freshSnapshot, initialSteps, isGuildBusy, runBuildJob } from "../core/serverAutopilot/build.js";
import { detectNaming } from "../core/serverAutopilot/detect.js";
import { runGeneration } from "../core/serverAutopilot/generate.js";
import { computePlan } from "../core/serverAutopilot/plan.js";
import { structureOf, type GuildSnapshot } from "../core/serverAutopilot/snapshot.js";
import {
  activeBuild,
  deleteBackup,
  getBackup,
  getBuild,
  getGeneration,
  insertBuild,
  insertGeneration,
  listBackups,
  listBuilds,
  listGenerations,
  runningGeneration,
  updateBuild,
  type BuildRow,
} from "../core/serverAutopilot/store.js";
import { normalizeTemplate, parseTemplateInput } from "../core/serverAutopilot/template.js";
import { SA_LIMITS, SA_MODES, type SABuild, type SAMode, type SAPerson, type SATemplate } from "../core/serverAutopilot/types.js";
import { trackDashboardAction } from "./dashboardAudit.js";
import { SlidingWindowLimiter } from "./rateLimit.js";

// Response shapes are the bot ⇄ website contract for Server Autopilot (see the spec mirrored in
// the website's src/lib/serverAutopilot.ts). Every route answers fast: generations and builds are
// background jobs the site polls.

const log = getLogger("server_autopilot");

export type SABridgeResponse = { status: number; json: Record<string, unknown> };

class SABridgeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const ok = (json: Record<string, unknown> = {}, status = 200): SABridgeResponse => ({ status, json: { ok: true, ...json } });

/** Abuse limits per server (free and One alike): 6 generations and 6 builds/restores an hour. */
const HOUR = 60 * 60_000;
const generateLimiter = new SlidingWindowLimiter(6, HOUR);
const buildLimiter = new SlidingWindowLimiter(6, HOUR);

function limited(limiter: SlidingWindowLimiter, guildId: string, what: string): void {
  const result = limiter.take(guildId);
  if (!result.ok) {
    const minutes = Math.max(1, Math.ceil(result.retryAfterMs / 60_000));
    throw new SABridgeError(`That's a lot of ${what} for one hour. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`, 429, { code: "rate_limited" });
  }
}

// ── People ──────────────────────────────────────────────────────────────────

async function resolvePeople(guild: Guild, ids: Iterable<string | null | undefined>): Promise<Map<string, SAPerson>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id) && /^\d{15,25}$/.test(id!)))];
  const people = new Map<string, SAPerson>();
  const missing = unique.filter((id) => !guild.members.cache.has(id));
  if (missing.length) await guild.members.fetch({ user: missing.slice(0, 100) }).catch(() => null);
  for (const id of unique) {
    const member = guild.members.cache.get(id);
    if (member) {
      people.set(id, { userId: id, name: member.displayName, avatarUrl: member.displayAvatarURL({ size: 64, extension: "png" }) });
      continue;
    }
    const user = guild.client.users.cache.get(id) ?? (await guild.client.users.fetch(id).catch(() => null));
    people.set(id, {
      userId: id,
      name: user?.displayName ?? user?.username ?? `Unknown user (${id.slice(-4)})`,
      avatarUrl: user?.displayAvatarURL({ size: 64, extension: "png" }) ?? null,
    });
  }
  return people;
}

const personOf = (people: Map<string, SAPerson>, id: string | null) => (id ? (people.get(id) ?? null) : null);
const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toBuild(row: BuildRow, people: Map<string, SAPerson>): SABuild {
  return {
    id: row.id,
    kind: row.kind === "restore" ? "restore" : "build",
    status: row.status as SABuild["status"],
    mode: (row.mode as SAMode | null) ?? null,
    templateName: row.templateName,
    steps: safeJson(row.steps, initialSteps()),
    errors: safeJson(row.errors, []),
    backupId: row.backupId,
    createdBy: personOf(people, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    result: safeJson(row.result, null),
  };
}

// ── Inputs ──────────────────────────────────────────────────────────────────

function parseMode(value: unknown): SAMode {
  if (typeof value === "string" && (SA_MODES as readonly string[]).includes(value)) return value as SAMode;
  throw new SABridgeError("mode must be add, merge or fresh.");
}

function parseKeep(value: unknown): { channelIds: string[]; roleIds: string[] } {
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && /^\d{15,25}$/.test(x)))].slice(0, 500) : []);
  return { channelIds: ids(rec.channelIds), roleIds: ids(rec.roleIds) };
}

function parseTemplate(value: unknown): SATemplate {
  const parsed = parseTemplateInput(value);
  if (!parsed.ok) throw new SABridgeError("This template has problems to fix first.", 422, { issues: parsed.issues });
  return normalizeTemplate(parsed.template).template;
}

/** Keep-list ids must belong to this guild (cross-guild safety). */
function keepInGuild(snap: GuildSnapshot, keep: { channelIds: string[]; roleIds: string[] }) {
  const channels = new Set(snap.channels.map((c) => c.id));
  const roles = new Set(snap.roles.map((r) => r.id));
  return { channelIds: keep.channelIds.filter((id) => channels.has(id)), roleIds: keep.roleIds.filter((id) => roles.has(id)) };
}

function confirmMatches(guild: Guild, value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === guild.name.trim().toLowerCase();
}

function audit(client: Client, guildId: string, userId: string, title: string, summary: string, payload: Record<string, unknown>): void {
  trackDashboardAction(client, guildId, userId, { eventType: "dashboard_config", title, summary, details: [], payload });
}

// ── Routes ──────────────────────────────────────────────────────────────────

async function scanRoute(guild: Guild): Promise<SABridgeResponse> {
  const snap = await freshSnapshot(guild);
  const detected = detectNaming({
    text: snap.channels.filter((c) => c.kind === "text" || c.kind === "announcement" || c.kind === "forum").map((c) => c.name),
    voice: snap.channels.filter((c) => c.kind === "voice" || c.kind === "stage").map((c) => c.name),
    categories: snap.channels.filter((c) => c.kind === "category").map((c) => c.name),
  });
  const ai = await getAiGateStatus(guild.id);
  const perms = BigInt(snap.bot.permissions);
  const has = (flag: bigint) => snap.bot.administrator || (perms & flag) !== 0n;
  const generation = runningGeneration(guild.id);
  const build = activeBuild(guild.id);
  return ok({
    guild: {
      id: guild.id,
      name: guild.name,
      iconUrl: guild.iconURL({ size: 128, extension: "png" }),
      memberCount: guild.memberCount,
      boostTier: guild.premiumTier,
      community: snap.community,
    },
    structure: structureOf(snap),
    detected,
    bot: {
      manageChannels: has(PermissionFlagsBits.ManageChannels),
      manageRoles: has(PermissionFlagsBits.ManageRoles),
      administrator: snap.bot.administrator,
      highestRolePosition: snap.bot.highestPosition,
    },
    ai: { oneActive: ai.oneActive, freeUsesRemaining: ai.freeUsesRemaining, freeUsesLimit: AI_FREE_USES_LIMIT },
    limits: SA_LIMITS,
    running: { generationId: generation?.id ?? null, buildId: build?.id ?? null },
  });
}

async function generateRoute(client: Client, guild: Guild, body: Record<string, unknown>, userId: string): Promise<SABridgeResponse> {
  if (runningGeneration(guild.id)) throw new SABridgeError("Autopilot is already generating templates for this server.", 409, { code: "busy" });
  const answers = parseAnswers(body.answers);
  // Peek first, so a guild with no uses left doesn't burn a rate-limit slot on a blocked request.
  const standing = await getAiGateStatus(guild.id);
  if (!standing.oneActive && standing.freeUsesRemaining <= 0) throw new SABridgeError(AI_ONE_REQUIRED, 403, { code: "one_required" });
  limited(generateLimiter, guild.id, "generations");
  const gate = await consumeAiGate(guild.id);
  if (!gate.ok) throw new SABridgeError(gate.error, 403, { code: "one_required" });
  const row = insertGeneration({ guildId: guild.id, answers: JSON.stringify(answers), charged: !gate.oneActive, createdBy: userId });
  runGeneration(guild, row.id, answers);
  audit(client, guild.id, userId, "Server Autopilot templates generated", "Autopilot started designing 3 server templates.", { generationId: row.id });
  return ok({ generationId: row.id }, 202);
}

async function generationRoute(guild: Guild, id: number): Promise<SABridgeResponse> {
  const row = getGeneration(guild.id, id);
  if (!row) throw new SABridgeError("That generation doesn't exist.", 404);
  const people = await resolvePeople(guild, [row.createdBy]);
  return ok({
    generation: {
      id: row.id,
      status: row.status,
      progress: { done: Math.min(SA_LIMITS.generateTemplates, row.progress), total: SA_LIMITS.generateTemplates },
      answers: safeJson(row.answers, {}),
      templates: safeJson(row.templates, []),
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      createdBy: personOf(people, row.createdBy),
    },
  });
}

async function generationsRoute(guild: Guild): Promise<SABridgeResponse> {
  const rows = listGenerations(guild.id);
  const people = await resolvePeople(guild, rows.map((r) => r.createdBy));
  return ok({
    generations: rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      createdBy: personOf(people, row.createdBy),
      templateNames: safeJson<Array<{ name?: string }>>(row.templates, []).map((t) => t.name ?? "").filter(Boolean),
    })),
  });
}

async function planRoute(guild: Guild, body: Record<string, unknown>): Promise<SABridgeResponse> {
  const template = parseTemplate(body.template);
  const mode = parseMode(body.mode);
  const snap = await freshSnapshot(guild);
  const { plan } = computePlan({ template, mode, keep: keepInGuild(snap, parseKeep(body.keep)), snap });
  return ok({ plan, template });
}

async function buildRoute(client: Client, guild: Guild, body: Record<string, unknown>, userId: string): Promise<SABridgeResponse> {
  if (activeBuild(guild.id) || isGuildBusy(guild.id)) throw new SABridgeError("A build is already running on this server.", 409, { code: "busy" });
  const template = parseTemplate(body.template);
  const mode = parseMode(body.mode);
  const snap = await freshSnapshot(guild);
  const keep = keepInGuild(snap, parseKeep(body.keep));
  const { plan } = computePlan({ template, mode, keep, snap });
  if (plan.blockers.length) throw new SABridgeError(plan.blockers[0]!, 400, { code: "blocked", blockers: plan.blockers });
  if (plan.requiresConfirm && !confirmMatches(guild, body.confirmName)) {
    throw new SABridgeError("This build removes channels or roles. Type the server name to confirm.", 400, { code: "confirm_required" });
  }
  limited(buildLimiter, guild.id, "builds");
  const generationId = typeof body.generationId === "number" && Number.isInteger(body.generationId) && getGeneration(guild.id, body.generationId) ? body.generationId : null;
  const row = insertBuild({
    guildId: guild.id,
    kind: "build",
    status: "queued",
    mode,
    templateName: template.name,
    generationId,
    template: JSON.stringify(template),
    naming: JSON.stringify(template.naming),
    keep: JSON.stringify(keep),
    plan: JSON.stringify(plan),
    steps: JSON.stringify(initialSteps()),
    errors: "[]",
    idMap: "{}",
    createdBy: userId,
    createdAt: new Date(),
  });
  runBuildJob(client, guild, row.id);
  audit(client, guild.id, userId, "Server Autopilot build started", `Building "${template.name}" in ${mode} mode (${plan.counts.create} to create, ${plan.counts.update} to update, ${plan.counts.delete} to delete).`, {
    buildId: row.id,
    mode,
    counts: plan.counts,
  });
  return ok({ buildId: row.id }, 202);
}

async function buildsRoute(guild: Guild): Promise<SABridgeResponse> {
  const rows = listBuilds(guild.id, 20);
  const people = await resolvePeople(guild, rows.map((r) => r.createdBy));
  return ok({ builds: rows.map((row) => toBuild(row, people)) });
}

async function buildOneRoute(guild: Guild, id: number): Promise<SABridgeResponse> {
  const row = getBuild(guild.id, id);
  if (!row) throw new SABridgeError("That build doesn't exist.", 404);
  const people = await resolvePeople(guild, [row.createdBy]);
  return ok({ build: toBuild(row, people) });
}

function cancelRoute(guild: Guild, id: number): SABridgeResponse {
  const row = getBuild(guild.id, id);
  if (!row) throw new SABridgeError("That build doesn't exist.", 404);
  if (row.status === "queued" || row.status === "running") updateBuild(row.id, { cancelRequested: true });
  return ok();
}

async function backupsRoute(guild: Guild): Promise<SABridgeResponse> {
  const rows = listBackups(guild.id);
  const people = await resolvePeople(guild, rows.map((r) => r.createdBy));
  return ok({
    backups: rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      createdBy: personOf(people, row.createdBy),
      roles: row.roleCount,
      channels: row.channelCount,
      buildId: row.buildId,
    })),
  });
}

async function backupSummary(guild: Guild, row: { id: number; reason: string; createdAt: Date; createdBy: string | null; roleCount: number; channelCount: number; buildId: number | null }) {
  const people = await resolvePeople(guild, [row.createdBy]);
  return {
    id: row.id,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    createdBy: personOf(people, row.createdBy),
    roles: row.roleCount,
    channels: row.channelCount,
    buildId: row.buildId,
  };
}

async function createBackupRoute(client: Client, guild: Guild, userId: string): Promise<SABridgeResponse> {
  if (isGuildBusy(guild.id)) throw new SABridgeError("Wait for the running build to finish first.", 409, { code: "busy" });
  const row = await createBackup(guild, { reason: "manual", buildId: null, userId });
  audit(client, guild.id, userId, "Server Autopilot backup created", `Saved a structure backup (${row.roleCount} roles, ${row.channelCount} channels).`, { backupId: row.id });
  return ok({ backup: await backupSummary(guild, row) });
}

async function backupOneRoute(guild: Guild, id: number): Promise<SABridgeResponse> {
  const row = getBackup(guild.id, id);
  const structure = row ? parseBackupStructure(row.structure) : null;
  if (!row || !structure) throw new SABridgeError("That backup doesn't exist.", 404);
  const me = guild.members.me;
  const bot = {
    userId: me?.id ?? guild.client.user.id,
    roleId: me?.roles.botRole?.id ?? null,
    highestPosition: me?.roles.highest.position ?? 0,
    permissions: (me?.permissions.bitfield ?? 0n).toString(),
    administrator: Boolean(me?.permissions.has(PermissionFlagsBits.Administrator)),
  };
  return ok({ backup: { ...(await backupSummary(guild, row)), ...backupCounts(structure) }, structure: backupStructureView(structure, bot) });
}

async function restoreRoute(client: Client, guild: Guild, id: number, body: Record<string, unknown>, userId: string): Promise<SABridgeResponse> {
  const row = getBackup(guild.id, id);
  if (!row || !parseBackupStructure(row.structure)) throw new SABridgeError("That backup doesn't exist.", 404);
  if (activeBuild(guild.id) || isGuildBusy(guild.id)) throw new SABridgeError("A build is already running on this server.", 409, { code: "busy" });
  const removeAdded = body.removeAdded === true;
  const restoreConfig = body.restoreConfig === true;
  if (removeAdded && !confirmMatches(guild, body.confirmName)) {
    throw new SABridgeError("Removing what was added deletes channels and roles. Type the server name to confirm.", 400, { code: "confirm_required" });
  }
  limited(buildLimiter, guild.id, "builds");
  const build = insertBuild({
    guildId: guild.id,
    kind: "restore",
    status: "queued",
    mode: null,
    templateName: null,
    options: JSON.stringify({ backupId: row.id, removeAdded, restoreConfig }),
    steps: JSON.stringify(initialSteps()),
    errors: "[]",
    idMap: "{}",
    backupId: row.id,
    createdBy: userId,
    createdAt: new Date(),
  });
  runBuildJob(client, guild, build.id);
  audit(client, guild.id, userId, "Server Autopilot restore started", `Restoring the backup from ${row.createdAt.toISOString().slice(0, 10)}${removeAdded ? ", removing what was added since" : ""}${restoreConfig ? ", with Dreamliner settings" : ""}.`, {
    backupId: row.id,
    buildId: build.id,
  });
  return ok({ buildId: build.id }, 202);
}

function deleteBackupRoute(client: Client, guild: Guild, id: number, userId: string): SABridgeResponse {
  if (!deleteBackup(guild.id, id)) throw new SABridgeError("That backup doesn't exist.", 404);
  audit(client, guild.id, userId, "Server Autopilot backup deleted", `Deleted backup #${id}.`, { backupId: id });
  return ok();
}

/**
 * Routes under /bridge/guilds/:guildId/server-autopilot/. The bridge has already checked
 * Manage Server for `userId`.
 */
export async function handleServerAutopilotBridge(
  client: Client,
  guild: Guild,
  method: string,
  segments: string[],
  body: Record<string, unknown>,
  userId: string,
): Promise<SABridgeResponse> {
  try {
    const [area, idPart, action] = segments;
    const id = idPart && /^\d{1,12}$/.test(idPart) ? Number(idPart) : null;
    if (idPart && id === null) throw new SABridgeError("Not found", 404);
    switch (area) {
      case "scan":
        if (method === "GET" && !idPart) return await scanRoute(guild);
        break;
      case "generate":
        if (method === "POST" && !idPart) return await generateRoute(client, guild, body, userId);
        break;
      case "generations":
        if (method === "GET" && id === null) return await generationsRoute(guild);
        if (method === "GET" && id !== null && !action) return await generationRoute(guild, id);
        break;
      case "plan":
        if (method === "POST" && !idPart) return await planRoute(guild, body);
        break;
      case "build":
        if (method === "POST" && !idPart) return await buildRoute(client, guild, body, userId);
        break;
      case "builds":
        if (method === "GET" && id === null) return await buildsRoute(guild);
        if (method === "GET" && id !== null && !action) return await buildOneRoute(guild, id);
        if (method === "POST" && id !== null && action === "cancel") return cancelRoute(guild, id);
        break;
      case "backups":
        if (method === "GET" && id === null) return await backupsRoute(guild);
        if (method === "POST" && id === null) return await createBackupRoute(client, guild, userId);
        if (method === "GET" && id !== null && !action) return await backupOneRoute(guild, id);
        if (method === "POST" && id !== null && action === "restore") return await restoreRoute(client, guild, id, body, userId);
        if (method === "DELETE" && id !== null && !action) return deleteBackupRoute(client, guild, id, userId);
        break;
    }
    throw new SABridgeError("Not found", 404);
  } catch (error) {
    if (error instanceof SABridgeError) return { status: error.status, json: { error: error.message, ...error.extra } };
    log.error("[server_autopilot] Bridge request failed:", error);
    return { status: 500, json: { error: "Server Autopilot request failed" } };
  }
}
