/**
 * Server Autopilot build runner: executes a plan (or a restore) against Discord, one operation at
 * a time. Progress, errors and every created id are written to the build row as they happen, so
 * the dashboard can poll it and a rerun after a restart picks up the ids it already made.
 *
 * Safety order: backup first; creates and updates next; deletes (fresh mode) only at the very
 * end and only when every create succeeded. Cancelling stops before the next operation.
 */
import {
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  type CategoryChannel,
  type Client,
  type Guild,
  type GuildChannel,
  type GuildChannelCreateOptions,
  type OverwriteResolvable,
} from "discord.js";
import { configManager } from "../../config/manager.js";
import { rollbackToSnapshot } from "../../config/snapshotRollback.js";
import { createSnapshot } from "../../config/snapshots.js";
import { getLogger } from "../logger.js";
import { backupCounts, computeRestorePlan, parseBackupStructure, serializeBackup, type BackupOverwrite } from "./backup.js";
import { postStarterMessage } from "./messages.js";
import { computePlan, pluginLabel, type ChannelAction, type IdMap, type StoredOverwrite } from "./plan.js";
import { isStaffPreset } from "./permissions.js";
import { configurePlugin } from "./plugins.js";
import { protectedChannelIds, snapshotGuild, type GuildSnapshot, type SnapKind } from "./snapshot.js";
import { cancelRequested, getBackup, getBuild, insertBackup, lastUnfinishedBuild, updateBuild, type BackupRow, type BuildRow } from "./store.js";
import { templateChannels } from "./template.js";
import { STEP_LABELS, type SABuildResult, type SAMode, type SAStep, type SAStepId, type SATemplate } from "./types.js";

const log = getLogger("server_autopilot");

const BUILD_STEPS: SAStepId[] = ["backup", "roles", "categories", "channels", "permissions", "order", "cleanup", "plugins", "messages"];

export function initialSteps(): SAStep[] {
  return BUILD_STEPS.map((id) => ({ id, label: STEP_LABELS[id], status: "pending", done: 0, total: 0, note: "" }));
}

/** Guilds with a job running in this process (the DB row is the cross-restart record). */
const runningGuilds = new Set<string>();

export function isGuildBusy(guildId: string): boolean {
  return runningGuilds.has(guildId);
}

class Cancelled extends Error {}

function apiCode(error: unknown): number | null {
  if (error instanceof DiscordAPIError) return typeof error.code === "number" ? error.code : null;
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : null;
}

export function describeError(error: unknown): string {
  switch (apiCode(error)) {
    case 50013:
      return "Dreamliner is missing a permission for this (or the item is above its role).";
    case 50001:
      return "Dreamliner can't see this channel.";
    case 10003:
      return "The channel no longer exists.";
    case 10011:
      return "The role no longer exists.";
    case 30013:
      return "The server has reached Discord's channel limit.";
    case 30005:
      return "The server has reached Discord's role limit.";
    case 50024:
      return "Discord doesn't allow this on that kind of channel.";
    case 50035: {
      const message = error instanceof Error ? error.message.replace(/^Invalid Form Body\s*/i, "").trim() : "";
      return `Discord rejected it${message ? `: ${message.slice(0, 200)}` : "."}`;
    }
    default:
      return error instanceof Error && error.message ? error.message.slice(0, 300) : "Something went wrong.";
  }
}

const RAW_TYPES: Record<string, ChannelType> = {
  category: ChannelType.GuildCategory,
  text: ChannelType.GuildText,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  voice: ChannelType.GuildVoice,
  stage: ChannelType.GuildStageVoice,
};

// ── Job bookkeeping ─────────────────────────────────────────────────────────

class Job {
  steps: SAStep[];
  errors: Array<{ step: string; message: string }>;
  idMap: IdMap;
  created = 0;
  updated = 0;
  deleted = 0;
  private current: SAStep | null = null;

  constructor(
    readonly row: BuildRow,
    readonly guild: Guild,
  ) {
    this.steps = safeJson<SAStep[]>(row.steps, []);
    if (!this.steps.length) this.steps = initialSteps();
    this.errors = safeJson(row.errors, []);
    const map = safeJson<Partial<IdMap>>(row.idMap, {});
    this.idMap = { roles: map.roles ?? {}, channels: map.channels ?? {} };
  }

  save(extra: Partial<BuildRow> = {}): void {
    updateBuild(this.row.id, { steps: JSON.stringify(this.steps), errors: JSON.stringify(this.errors), idMap: JSON.stringify(this.idMap), ...extra });
  }

  step(id: SAStepId): SAStep {
    return this.steps.find((s) => s.id === id)!;
  }

  begin(id: SAStepId, total: number): void {
    const step = this.step(id);
    step.status = "running";
    step.total = total;
    step.done = 0;
    this.current = step;
    this.save();
  }

  finish(id: SAStepId, note = ""): void {
    const step = this.step(id);
    const failures = this.errors.filter((e) => e.step === id).length;
    step.status = failures && failures >= Math.max(1, step.total) ? "failed" : "done";
    step.note = note || (failures ? `${failures} problem${failures === 1 ? "" : "s"}, see below` : "");
    this.current = null;
    this.save();
  }

  skip(id: SAStepId, note: string): void {
    const step = this.step(id);
    step.status = "skipped";
    step.note = note;
    this.save();
  }

  /** Runs one Discord operation: cancel check first, errors recorded (never thrown). */
  async op<T>(id: SAStepId, label: string, fn: () => Promise<T>): Promise<T | null> {
    if (cancelRequested(this.row.id)) throw new Cancelled();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      this.errors.push({ step: id, message: `${label}: ${describeError(error)}` });
      return null;
    } finally {
      this.step(id).done += 1;
      this.save();
    }
  }

  failCurrent(note: string): void {
    if (this.current) {
      this.current.status = "failed";
      this.current.note = note;
    }
  }

  skipRest(note: string): void {
    for (const step of this.steps) if (step.status === "pending") step.status = "skipped";
    if (this.current?.status === "running") {
      this.current.status = "skipped";
      this.current.note = note;
    }
  }

  stepFailed(...ids: SAStepId[]): boolean {
    return this.errors.some((e) => ids.includes(e.step as SAStepId));
  }
}

function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ── Backups ─────────────────────────────────────────────────────────────────

/** Ids of every channel any Dreamliner log setting points at (protected from deletion). */
export async function dreamlinerLogChannelIds(guildId: string): Promise<string[]> {
  const config = (await configManager.getEffectiveConfig(guildId)) as unknown as Record<string, unknown>;
  const ids = new Set<string>();
  for (const key of ["server_log_channel_id", "moderation_log_channel_id", "log_channel_id"]) {
    const v = config[key];
    if (typeof v === "string" && v) ids.add(v);
  }
  const logging = config.logging as { channels?: Record<string, string> } | undefined;
  for (const v of Object.values(logging?.channels ?? {})) if (typeof v === "string" && v) ids.add(v);
  const plugins = (config.plugins ?? {}) as Record<string, { config?: Record<string, unknown> }>;
  for (const section of Object.values(plugins)) {
    const v = section?.config?.log_channel_id;
    if (typeof v === "string" && v) ids.add(v);
  }
  return [...ids];
}

export async function freshSnapshot(guild: Guild): Promise<GuildSnapshot> {
  await guild.channels.fetch().catch(() => null);
  await guild.roles.fetch().catch(() => null);
  await guild.members.fetchMe().catch(() => null);
  return snapshotGuild(guild, await dreamlinerLogChannelIds(guild.id));
}

/** Saves a structure backup plus a config snapshot. */
export async function createBackup(guild: Guild, input: { reason: "auto" | "manual"; buildId: number | null; userId: string; snap?: GuildSnapshot }): Promise<BackupRow> {
  const snap = input.snap ?? (await freshSnapshot(guild));
  const structure = serializeBackup(snap, new Date());
  const counts = backupCounts(structure);
  const config = await createSnapshot({
    guildId: guild.id,
    label: input.reason === "auto" ? "Before Server Autopilot" : "Server Autopilot backup",
    reason: "server_autopilot",
    createdBy: input.userId,
  });
  return insertBackup({
    guildId: guild.id,
    reason: input.reason,
    structure: JSON.stringify(structure),
    roleCount: counts.roles,
    channelCount: counts.channels,
    configSnapshotId: config.id,
    buildId: input.buildId,
    createdBy: input.userId,
    createdAt: new Date(),
  });
}

// ── Overwrites ──────────────────────────────────────────────────────────────

function resolveStored(job: Job, list: StoredOverwrite[]): OverwriteResolvable[] {
  const out: OverwriteResolvable[] = [];
  const me = job.guild.members.me?.id ?? job.guild.client.user.id;
  for (const o of list) {
    const allow = BigInt(o.allow);
    const deny = BigInt(o.deny);
    if (o.target.kind === "everyone") out.push({ id: job.guild.id, type: OverwriteType.Role, allow, deny });
    else if (o.target.kind === "bot") out.push({ id: me, type: OverwriteType.Member, allow, deny });
    else {
      const id = job.idMap.roles[o.target.key];
      if (id && job.guild.roles.cache.has(id)) out.push({ id, type: OverwriteType.Role, allow, deny });
    }
  }
  return out;
}

/** Desired overwrites plus any existing ones Autopilot doesn't manage (other roles, members). */
function mergedOverwrites(channel: GuildChannel, desired: OverwriteResolvable[], managedIds: Set<string>): OverwriteResolvable[] {
  const kept: OverwriteResolvable[] = [...channel.permissionOverwrites.cache.values()]
    .filter((o) => !managedIds.has(o.id))
    .map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));
  return [...desired, ...kept];
}

/** A channel's current overwrites, in the shape channel create / set take. */
function currentOverwrites(channel: GuildChannel): OverwriteResolvable[] {
  return [...channel.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));
}

function channelOf(guild: Guild, id: string | null | undefined): GuildChannel | null {
  if (!id) return null;
  const channel = guild.channels.cache.get(id);
  return channel && !channel.isThread() ? (channel as GuildChannel) : null;
}

// ── Build ───────────────────────────────────────────────────────────────────

type BuildInputs = { template: SATemplate; mode: SAMode; keep: { channelIds: string[]; roleIds: string[] } };

async function runTemplateBuild(job: Job, client: Client, inputs: BuildInputs): Promise<SABuildResult> {
  const { guild } = job;
  const userId = job.row.createdBy ?? "";

  // Seed ids from an interrupted earlier run of the same template, when they still exist.
  if (!Object.keys(job.idMap.roles).length && !Object.keys(job.idMap.channels).length) {
    const previous = lastUnfinishedBuild(guild.id, inputs.template.id, job.row.id);
    if (previous) {
      const map = safeJson<Partial<IdMap>>(previous.idMap, {});
      job.idMap = { roles: { ...(map.roles ?? {}) }, channels: { ...(map.channels ?? {}) } };
    }
  }

  const snap = await freshSnapshot(guild);
  for (const [key, id] of Object.entries(job.idMap.roles)) if (!guild.roles.cache.has(id)) delete job.idMap.roles[key];
  for (const [key, id] of Object.entries(job.idMap.channels)) if (!guild.channels.cache.has(id)) delete job.idMap.channels[key];
  const { plan, resolved } = computePlan({ ...inputs, snap, idMap: job.idMap });
  job.save({ plan: JSON.stringify(plan) });
  if (plan.blockers.length) throw new Error(plan.blockers[0]);

  // 1. Backup
  job.begin("backup", 1);
  const backup = await createBackup(guild, { reason: "auto", buildId: job.row.id, userId, snap });
  job.step("backup").done = 1;
  job.save({ backupId: backup.id });
  job.finish("backup", "Structure and Dreamliner settings saved");

  // 2. Roles
  const roleWork = resolved.roles.filter((r) => r.action !== "reuse");
  for (const r of resolved.roles) if (r.action === "reuse" && r.roleId) job.idMap.roles[r.key] = r.roleId;
  job.begin("roles", roleWork.length);
  for (const r of roleWork) {
    if (r.action === "create") {
      if (job.idMap.roles[r.key]) {
        job.step("roles").done += 1;
        continue;
      }
      const role = await job.op("roles", `Couldn't create @${r.name}`, () =>
        guild.roles.create({ name: r.name, color: r.color ?? undefined, hoist: r.hoist, mentionable: r.mentionable, permissions: BigInt(r.permissions), reason: "Server Autopilot" }),
      );
      if (role) {
        job.idMap.roles[r.key] = role.id;
        job.created += 1;
      }
    } else {
      const role = guild.roles.cache.get(r.roleId!);
      job.idMap.roles[r.key] = r.roleId!;
      const done = await job.op("roles", `Couldn't update @${role?.name ?? r.name}`, async () => {
        if (!role) throw new Error("The role no longer exists.");
        await role.edit({
          ...(r.changes.includes("name") ? { name: r.name } : {}),
          ...(r.changes.includes("color") && r.color !== null ? { color: r.color } : {}),
          ...(r.changes.includes("hoist") ? { hoist: r.hoist } : {}),
          ...(r.changes.includes("mentionable") ? { mentionable: r.mentionable } : {}),
          ...(r.changes.includes("permissions") ? { permissions: BigInt(r.permissions) } : {}),
          reason: "Server Autopilot",
        });
        return true;
      });
      if (done) job.updated += 1;
    }
  }
  job.save();
  job.finish("roles");

  const managedIds = new Set<string>([guild.id, guild.members.me?.id ?? "", ...Object.values(job.idMap.roles)]);

  // 3. Categories
  for (const c of resolved.categories) if (c.channelId) job.idMap.channels[c.key] = c.channelId;
  const categoryWork = resolved.categories.filter((c) => c.action === "create" || (c.action === "update" && c.changes.includes("name")));
  job.begin("categories", categoryWork.length);
  for (const c of categoryWork) {
    if (c.action === "create") {
      if (job.idMap.channels[c.key] && guild.channels.cache.has(job.idMap.channels[c.key]!)) {
        job.step("categories").done += 1;
        continue;
      }
      const created = await job.op("categories", `Couldn't create the ${c.name} category`, () =>
        guild.channels.create({ name: c.name, type: ChannelType.GuildCategory, permissionOverwrites: resolveStored(job, c.overwrites), reason: "Server Autopilot" }),
      );
      if (created) {
        job.idMap.channels[c.key] = created.id;
        job.created += 1;
      }
    } else {
      const channel = channelOf(guild, c.channelId);
      const done = await job.op("categories", `Couldn't rename ${channel?.name ?? c.name}`, async () => {
        if (!channel) throw new Error("The category no longer exists.");
        await channel.setName(c.name, "Server Autopilot");
        return true;
      });
      if (done) job.updated += 1;
    }
  }
  job.save();
  job.finish("categories");

  // 4. Channels
  for (const c of resolved.channels) if (c.channelId) job.idMap.channels[c.key] = c.channelId;
  const categoryOverwrites = new Map(resolved.categories.map((c) => [c.key, c.overwrites]));
  const channelWork = resolved.channels.filter((c) => c.action === "create" || (c.action === "update" && c.changes.some((x) => x !== "permissions")));
  job.begin("channels", channelWork.length);
  for (const c of channelWork) {
    const parentId = c.parentKey ? (job.idMap.channels[c.parentKey] ?? null) : null;
    if (c.action === "create") {
      if (job.idMap.channels[c.key] && guild.channels.cache.has(job.idMap.channels[c.key]!)) {
        job.step("channels").done += 1;
        continue;
      }
      // A synced channel copies its category exactly as it is now (a reused category may carry
      // more than the plan), so Discord shows it as synced and it can't end up more open.
      const parent = c.syncWithParent ? channelOf(guild, parentId) : null;
      const overwrites = parent ? currentOverwrites(parent) : resolveStored(job, c.syncWithParent && c.parentKey ? (categoryOverwrites.get(c.parentKey) ?? []) : c.overwrites);
      const options: GuildChannelCreateOptions = {
        name: c.name,
        type: RAW_TYPES[c.type] as GuildChannelCreateOptions["type"],
        parent: parentId ?? undefined,
        permissionOverwrites: overwrites,
        reason: "Server Autopilot",
      };
      if (c.type === "text" || c.type === "announcement" || c.type === "forum") {
        if (c.topic) options.topic = c.topic;
        options.nsfw = c.nsfw;
      }
      if (c.type === "text" || c.type === "forum") options.rateLimitPerUser = c.slowmode;
      if (c.type === "voice") {
        options.userLimit = c.userLimit;
        options.nsfw = c.nsfw;
      }
      const created = await job.op("channels", `Couldn't create ${c.name}`, () => guild.channels.create(options));
      if (created) {
        job.idMap.channels[c.key] = created.id;
        job.created += 1;
      }
    } else {
      const channel = channelOf(guild, c.channelId);
      const done = await job.op("channels", `Couldn't update ${channel?.name ?? c.name}`, async () => {
        if (!channel) throw new Error("The channel no longer exists.");
        const edit: Record<string, unknown> = { reason: "Server Autopilot" };
        if (c.changes.includes("name")) edit.name = c.name;
        if (c.changes.includes("topic")) edit.topic = c.topic;
        if (c.changes.includes("nsfw")) edit.nsfw = c.nsfw;
        if (c.changes.includes("slowmode")) edit.rateLimitPerUser = c.slowmode;
        if (c.changes.includes("user limit")) edit.userLimit = c.userLimit;
        if (c.changes.includes("move")) {
          edit.parent = parentId;
          edit.lockPermissions = false;
        }
        await channel.edit(edit);
        return true;
      });
      if (done) job.updated += 1;
    }
  }
  job.save();
  job.finish("channels");

  // 5. Permissions on reused categories/channels (new ones were created with theirs).
  const permissionWork: ChannelAction[] = [
    ...resolved.categories.filter((c) => c.action === "update" && c.changes.includes("permissions")),
    ...resolved.channels.filter((c) => c.action === "update" && (c.changes.includes("permissions") || (c.changes.includes("move") && c.syncWithParent))),
  ];
  // Channels the plan doesn't place itself, and channels that must never be touched.
  const plannedChannelIds = new Set(resolved.channels.map((c) => job.idMap.channels[c.key]).filter(Boolean));
  const untouchable = new Set<string>([...protectedChannelIds(snap), ...inputs.keep.channelIds]);
  job.begin("permissions", permissionWork.length);
  for (const c of permissionWork) {
    const channel = channelOf(guild, c.channelId);
    await job.op("permissions", `Couldn't set permissions on ${channel?.name ?? c.name}`, async () => {
      if (!channel) throw new Error("The channel no longer exists.");
      if (!c.isCategory && c.syncWithParent && channel.parent) {
        await channel.lockPermissions();
        return true;
      }
      // Discord doesn't push a category's new permissions to its channels: remember which were
      // synced so they follow it (otherwise a category made private leaves them public).
      const followers = c.isCategory
        ? [...guild.channels.cache.values()]
            .filter((ch) => !ch.isThread())
            .map((ch) => ch as GuildChannel)
            .filter((ch) => ch.parentId === channel.id && !plannedChannelIds.has(ch.id) && !untouchable.has(ch.id) && ch.permissionsLocked === true)
        : [];
      const desired = resolveStored(job, c.syncWithParent && c.parentKey ? (categoryOverwrites.get(c.parentKey) ?? []) : c.overwrites);
      await channel.permissionOverwrites.set(mergedOverwrites(channel, desired, managedIds), "Server Autopilot");
      for (const follower of followers) await follower.lockPermissions().catch(() => null);
      return true;
    });
  }
  job.save();
  job.finish("permissions");

  // 6. Order
  job.begin("order", 3);
  await job.op("order", "Couldn't reorder channels", async () => {
    await guild.channels.fetch();
    const positions: Array<{ channel: string; position: number }> = [];
    // Community, system, log and keep-list channels are never touched, not even moved.
    const placed = new Set<string>([...protectedChannelIds(snap), ...inputs.keep.channelIds]);
    let index = 0;
    for (const key of resolved.channelOrder[""] ?? []) {
      const id = job.idMap.channels[key];
      if (id && !placed.has(id)) {
        positions.push({ channel: id, position: index++ });
        placed.add(id);
      }
    }
    const categoryIds = resolved.categoryOrder.map((key) => job.idMap.channels[key]).filter((id): id is string => Boolean(id));
    const otherCategories = [...guild.channels.cache.values()]
      .filter((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && !categoryIds.includes(c.id))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => c.id);
    [...categoryIds, ...otherCategories].forEach((id, i) => {
      if (!placed.has(id)) positions.push({ channel: id, position: i });
    });
    for (const catKey of resolved.categoryOrder) {
      let pos = 0;
      for (const key of resolved.channelOrder[catKey] ?? []) {
        const id = job.idMap.channels[key];
        if (id && !placed.has(id)) {
          positions.push({ channel: id, position: pos });
          placed.add(id);
        }
        pos += 1;
      }
    }
    if (positions.length) await guild.channels.setPositions(positions);
  });
  await job.op("order", "Couldn't reorder roles", async () => {
    const top = (guild.members.me?.roles.highest.position ?? 1) - 1;
    const ids = resolved.roleOrder.map((key) => job.idMap.roles[key]).filter((id): id is string => Boolean(id));
    const movable = ids.filter((id) => {
      const role = guild.roles.cache.get(id);
      return role && !role.managed && role.position < top + 1;
    });
    if (movable.length < 2 || top < 1) return;
    await guild.roles.setPositions(movable.map((id, i) => ({ role: id, position: Math.max(1, top - i) })));
  });
  // Last check after all the moving: every channel meant to follow its category is synced to it.
  await job.op("order", "Couldn't sync some channels with their categories", async () => {
    await guild.channels.fetch();
    for (const c of resolved.channels) {
      if (!c.syncWithParent || c.action === "reuse") continue;
      const channel = channelOf(guild, job.idMap.channels[c.key]);
      if (!channel?.parent || untouchable.has(channel.id) || channel.permissionsLocked !== false) continue;
      await channel.lockPermissions();
    }
  });
  job.finish("order");

  // 7. Cleanup (fresh only, never after a failed create)
  if (resolved.deleteChannels.length || resolved.deleteRoles.length) {
    if (job.stepFailed("roles", "categories", "channels")) {
      job.skip("cleanup", "Skipped: some roles or channels couldn't be created, so nothing was removed.");
    } else {
      job.begin("cleanup", resolved.deleteChannels.length + resolved.deleteRoles.length);
      for (const d of resolved.deleteChannels) {
        const done = await job.op("cleanup", `Couldn't delete ${d.name}`, async () => {
          const channel = guild.channels.cache.get(d.id);
          if (!channel) return true;
          await channel.delete("Server Autopilot (fresh build)");
          return true;
        });
        if (done) job.deleted += 1;
      }
      for (const d of resolved.deleteRoles) {
        const done = await job.op("cleanup", `Couldn't delete @${d.name}`, async () => {
          const role = guild.roles.cache.get(d.id);
          if (!role) return true;
          await role.delete("Server Autopilot (fresh build)");
          return true;
        });
        if (done) job.deleted += 1;
      }
      job.finish("cleanup");
    }
  } else job.skip("cleanup", inputs.mode === "fresh" ? "Nothing to remove" : "Nothing is removed in this mode");

  // 8. Plugins
  const plugins: string[] = [];
  const channelId = (key: string | null) => (key ? (job.idMap.channels[key] ?? null) : null);
  const roleId = (key: string | null) => (key ? (job.idMap.roles[key] ?? null) : null);
  const flat = templateChannels(inputs.template);
  const targets = {
    channelId,
    roleId,
    roleIds: (keys: string[]) => keys.map((k) => roleId(k)).filter((id): id is string => Boolean(id)),
    channelByPurpose: (purposes: string[]) => {
      for (const purpose of purposes) {
        const hit = flat.find((f) => f.channel.purpose === purpose && channelId(f.channel.key));
        if (hit) return channelId(hit.channel.key);
      }
      return null;
    },
    staffRoleIds: inputs.template.roles.filter((r) => isStaffPreset(r.preset)).map((r) => roleId(r.key)).filter((id): id is string => Boolean(id)),
  };
  if (resolved.plugins.length) {
    job.begin("plugins", resolved.plugins.length);
    for (const setup of resolved.plugins) {
      const summary = await job.op("plugins", `Couldn't set up ${pluginLabel(setup.plugin)}`, () => configurePlugin(guild, setup, targets, userId));
      if (summary !== null) plugins.push(setup.plugin);
    }
    job.finish("plugins");
  } else job.skip("plugins", "No plugins in this template");

  // 9. Messages
  let messages = 0;
  if (resolved.messages.length) {
    job.begin("messages", resolved.messages.length);
    for (const message of resolved.messages) {
      const ok = await job.op("messages", `Couldn't post "${message.title}"`, async () => {
        await postStarterMessage({
          client,
          guild,
          message,
          roles: inputs.template.roles,
          channelId: (key) => channelId(key),
          roleId: (key) => roleId(key),
          actor: userId,
        });
        return true;
      });
      if (ok) messages += 1;
    }
    job.finish("messages");
  } else job.skip("messages", "No starter messages in this template");

  return {
    created: job.created,
    updated: job.updated,
    deleted: job.deleted,
    channels: flat
      .map((f) => ({ key: f.channel.key, id: job.idMap.channels[f.channel.key] ?? "", name: guild.channels.cache.get(job.idMap.channels[f.channel.key] ?? "")?.name ?? "" }))
      .filter((c) => c.id),
    messages,
    plugins,
  };
}

// ── Restore ─────────────────────────────────────────────────────────────────

type RestoreOptions = { backupId: number; removeAdded: boolean; restoreConfig: boolean };

async function runRestore(job: Job, options: RestoreOptions): Promise<SABuildResult> {
  const { guild } = job;
  const userId = job.row.createdBy ?? "";
  const row = getBackup(guild.id, options.backupId);
  const backup = row ? parseBackupStructure(row.structure) : null;
  if (!row || !backup) throw new Error("That backup no longer exists.");

  const snap = await freshSnapshot(guild);
  const plan = computeRestorePlan(backup, snap, options.removeAdded);
  for (const warning of plan.warnings) job.errors.push({ step: "roles", message: warning });

  job.begin("backup", 1);
  const safety = await createBackup(guild, { reason: "auto", buildId: job.row.id, userId, snap });
  job.step("backup").done = 1;
  job.save({ backupId: safety.id });
  job.finish("backup", "Current structure saved before restoring");

  // Roles: backup role id → live id.
  const roleIdFor = (backupId: string): string | null => job.idMap.roles[backupId] ?? (guild.roles.cache.has(backupId) ? backupId : null);
  const roleWork = plan.roles.filter((r) => r.action !== "skip");
  job.begin("roles", roleWork.length);
  for (const r of roleWork) {
    if (r.action === "create") {
      if (job.idMap.roles[r.backupId]) {
        job.step("roles").done += 1;
        continue;
      }
      const role = await job.op("roles", `Couldn't recreate @${r.name}`, () =>
        guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: BigInt(r.permissions), reason: "Server Autopilot restore" }),
      );
      if (role) {
        job.idMap.roles[r.backupId] = role.id;
        job.created += 1;
      }
    } else {
      const role = guild.roles.cache.get(r.roleId!);
      const done = await job.op("roles", `Couldn't restore @${r.name}`, async () => {
        if (!role) throw new Error("The role no longer exists.");
        await role.edit({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: BigInt(r.permissions), reason: "Server Autopilot restore" });
        return true;
      });
      if (done) job.updated += 1;
    }
  }
  job.save();
  job.finish("roles");

  const mapOverwrites = (list: BackupOverwrite[]): OverwriteResolvable[] => {
    const out: OverwriteResolvable[] = [];
    for (const o of list) {
      if (o.type === "member") {
        out.push({ id: o.id, type: OverwriteType.Member, allow: BigInt(o.allow), deny: BigInt(o.deny) });
        continue;
      }
      const id = o.id === backup.guildId ? guild.id : roleIdFor(o.id);
      if (id) out.push({ id, type: OverwriteType.Role, allow: BigInt(o.allow), deny: BigInt(o.deny) });
    }
    return out;
  };
  const channelIdFor = (backupId: string | null): string | null =>
    backupId ? (job.idMap.channels[backupId] ?? (guild.channels.cache.has(backupId) ? backupId : null)) : null;
  const setOverwrites = async (channel: GuildChannel, list: BackupOverwrite[]) => {
    try {
      await channel.permissionOverwrites.set(mapOverwrites(list), "Server Autopilot restore");
    } catch {
      // Members who left can't have overwrites: retry with roles only.
      await channel.permissionOverwrites.set(mapOverwrites(list.filter((o) => o.type === "role")), "Server Autopilot restore");
    }
  };

  const restoreChannels = async (stepId: SAStepId, list: typeof plan.channels) => {
    const work = list.filter((c) => c.action !== "skip");
    job.begin(stepId, work.length);
    for (const c of work) {
      if (c.action === "create") {
        if (job.idMap.channels[c.backupId]) {
          job.step(stepId).done += 1;
          continue;
        }
        const options: GuildChannelCreateOptions = {
          name: c.name,
          type: (Object.values(RAW_TYPES).includes(c.rawType) ? c.rawType : RAW_TYPES[c.kind] ?? ChannelType.GuildText) as GuildChannelCreateOptions["type"],
          parent: c.kind === "category" ? undefined : (channelIdFor(c.parentBackupId) ?? undefined),
          permissionOverwrites: mapOverwrites(c.overwrites),
          reason: "Server Autopilot restore",
        };
        if (c.kind === "text" || c.kind === "announcement" || c.kind === "forum") {
          if (c.topic) options.topic = c.topic;
          options.nsfw = c.nsfw;
        }
        if (c.kind === "text" || c.kind === "forum") options.rateLimitPerUser = c.slowmode;
        if (c.kind === "voice" || c.kind === "stage") {
          options.userLimit = c.userLimit;
          if (c.bitrate) options.bitrate = Math.min(c.bitrate, guild.maximumBitrate);
        }
        const created = await job.op(stepId, `Couldn't recreate ${c.name}`, async () => {
          try {
            return await guild.channels.create(options);
          } catch {
            // Members who left can't have overwrites: retry with role overwrites only.
            return await guild.channels.create({ ...options, permissionOverwrites: mapOverwrites(c.overwrites.filter((o) => o.type === "role")) });
          }
        });
        if (created) {
          job.idMap.channels[c.backupId] = created.id;
          job.created += 1;
        }
      } else {
        const channel = channelOf(guild, c.channelId);
        const done = await job.op(stepId, `Couldn't restore ${c.name}`, async () => {
          if (!channel) throw new Error("The channel no longer exists.");
          const edit: Record<string, unknown> = { reason: "Server Autopilot restore" };
          if (c.changes.includes("name")) edit.name = c.name;
          if (c.changes.includes("topic")) edit.topic = c.topic;
          if (c.changes.includes("nsfw")) edit.nsfw = c.nsfw;
          if (c.changes.includes("slowmode")) edit.rateLimitPerUser = c.slowmode;
          if (c.changes.includes("user limit")) edit.userLimit = c.userLimit;
          if (c.changes.includes("move")) {
            edit.parent = channelIdFor(c.parentBackupId);
            edit.lockPermissions = false;
          }
          if (Object.keys(edit).length > 1) await channel.edit(edit);
          return true;
        });
        if (done) job.updated += 1;
      }
    }
    job.save();
    job.finish(stepId);
  };
  await restoreChannels("categories", plan.categories);
  await restoreChannels("channels", plan.channels);

  // Overwrites on channels that still existed.
  const permissionWork = [...plan.categories, ...plan.channels].filter((c) => c.action === "update" && c.changes.includes("permissions"));
  job.begin("permissions", permissionWork.length);
  for (const c of permissionWork) {
    const channel = channelOf(guild, c.channelId);
    await job.op("permissions", `Couldn't restore permissions on ${c.name}`, async () => {
      if (!channel) throw new Error("The channel no longer exists.");
      await setOverwrites(channel, c.overwrites);
      return true;
    });
  }
  job.save();
  job.finish("permissions");

  // Order as in the backup.
  job.begin("order", 2);
  await job.op("order", "Couldn't reorder channels", async () => {
    await guild.channels.fetch();
    const positions = [...plan.categories, ...plan.channels]
      .map((c) => ({ id: channelIdFor(c.backupId), position: c.position, kind: c.kind }))
      .filter((p): p is { id: string; position: number; kind: SnapKind } => Boolean(p.id))
      .sort((a, b) => a.position - b.position)
      .map((p) => ({ channel: p.id, position: p.position }));
    if (positions.length) await guild.channels.setPositions(positions);
  });
  await job.op("order", "Couldn't reorder roles", async () => {
    const top = (guild.members.me?.roles.highest.position ?? 1) - 1;
    const ordered = [...plan.roles]
      .sort((a, b) => b.position - a.position)
      .map((r) => roleIdFor(r.backupId))
      .filter((id): id is string => {
        const role = id ? guild.roles.cache.get(id) : undefined;
        return Boolean(role && !role.managed && role.position <= top);
      });
    if (ordered.length < 2 || top < 1) return;
    await guild.roles.setPositions(ordered.map((id, i) => ({ role: id, position: Math.max(1, top - i) })));
  });
  job.finish("order");

  // Remove what was added after the backup (only when asked).
  if (options.removeAdded && (plan.deleteChannels.length || plan.deleteRoles.length)) {
    if (job.stepFailed("roles", "categories", "channels")) {
      job.skip("cleanup", "Skipped: some things couldn't be restored, so nothing was removed.");
    } else {
      job.begin("cleanup", plan.deleteChannels.length + plan.deleteRoles.length);
      for (const d of plan.deleteChannels) {
        const done = await job.op("cleanup", `Couldn't delete ${d.name}`, async () => {
          await guild.channels.cache.get(d.id)?.delete("Server Autopilot restore");
          return true;
        });
        if (done) job.deleted += 1;
      }
      for (const d of plan.deleteRoles) {
        const done = await job.op("cleanup", `Couldn't delete @${d.name}`, async () => {
          await guild.roles.cache.get(d.id)?.delete("Server Autopilot restore");
          return true;
        });
        if (done) job.deleted += 1;
      }
      job.finish("cleanup");
    }
  } else job.skip("cleanup", options.removeAdded ? "Nothing was added since the backup" : "Things added after the backup are kept");

  const plugins: string[] = [];
  if (options.restoreConfig && row.configSnapshotId) {
    job.begin("plugins", 1);
    const ok = await job.op("plugins", "Couldn't restore Dreamliner settings", async () => {
      const result = await rollbackToSnapshot(guild.id, row.configSnapshotId!, userId);
      if (!result.ok) throw new Error(result.error);
      return true;
    });
    if (ok) plugins.push("config");
    job.finish("plugins", ok ? "Dreamliner settings restored" : "");
  } else job.skip("plugins", "Dreamliner settings were left as they are");
  job.skip("messages", "Messages can't be restored");

  return {
    created: job.created,
    updated: job.updated,
    deleted: job.deleted,
    channels: [...plan.categories, ...plan.channels]
      .filter((c) => c.action === "create" && job.idMap.channels[c.backupId])
      .map((c) => ({ key: c.backupId, id: job.idMap.channels[c.backupId]!, name: c.name })),
    messages: 0,
    plugins,
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

/** Runs a queued build or restore in the background. */
export function runBuildJob(client: Client, guild: Guild, buildId: number): void {
  const row = getBuild(guild.id, buildId);
  if (!row || runningGuilds.has(guild.id)) return;
  runningGuilds.add(guild.id);
  const job = new Job(row, guild);
  void (async () => {
    job.save({ status: "running", startedAt: new Date() });
    try {
      let result: SABuildResult;
      if (row.kind === "restore") {
        result = await runRestore(job, safeJson<RestoreOptions>(row.options, { backupId: 0, removeAdded: false, restoreConfig: false }));
      } else {
        const template = safeJson<SATemplate | null>(row.template, null);
        if (!template) throw new Error("The build's template couldn't be read.");
        result = await runTemplateBuild(job, client, {
          template,
          mode: (row.mode as SAMode) ?? "add",
          keep: safeJson(row.keep, { channelIds: [], roleIds: [] }),
        });
      }
      job.save({ status: "done", result: JSON.stringify(result), finishedAt: new Date() });
    } catch (error) {
      if (error instanceof Cancelled) {
        job.skipRest("Cancelled");
        job.save({ status: "cancelled", finishedAt: new Date(), result: JSON.stringify(partialResult(job)) });
      } else {
        log.error(`[server_autopilot] Build ${buildId} failed:`, error);
        job.failCurrent(describeError(error));
        job.errors.push({ step: "build", message: describeError(error) });
        job.skipRest("");
        job.save({ status: "failed", finishedAt: new Date(), result: JSON.stringify(partialResult(job)) });
      }
    } finally {
      runningGuilds.delete(guild.id);
    }
  })();
}

function partialResult(job: Job): SABuildResult {
  return { created: job.created, updated: job.updated, deleted: job.deleted, channels: [], messages: 0, plugins: [] };
}
