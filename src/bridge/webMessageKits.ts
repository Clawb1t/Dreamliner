import { ChannelType, MessageFlags, PermissionFlagsBits, type Channel, type Client, type Guild, type GuildBasedChannel, type Message } from "discord.js";
import { fetchGuildChannel, fetchGuildTextChannel } from "../core/guildChannel.js";
import { autoGrantableRoleIds } from "../core/roles.js";
import { isOwnWebhookId, webhookTarget } from "../core/webhooks.js";
import { deleteKitAsset, isImageAsset, KitAssetError, listKitAssets, readKitAsset, saveKitAsset } from "../plugins/message_kits/functions/assets.js";
import { KIT_LIMITS } from "../plugins/message_kits/functions/constants.js";
import {
  formatIssuePath,
  kitPreview,
  listActionRefs,
  listAssetRefs,
  parseKitDocument,
  parseKitDraft,
  referencedAssetIds,
  type KitDocument,
  type KitIssue,
} from "../plugins/message_kits/functions/document.js";
import { documentFromMessageData, importKitJson, KitImportError } from "../plugins/message_kits/functions/importers.js";
import { runScheduleNow } from "../plugins/message_kits/functions/jobs.js";
import { checkScheduleRule, nextRunAt, SCHEDULE_REPEATS, zonedParts, type ScheduleRepeat } from "../plugins/message_kits/functions/schedule.js";
import {
  deletePost,
  describeDiscordError,
  KitSendError,
  kitDocumentOf,
  loadKitsRuntime,
  mapLimit,
  postUrl,
  refreshPost,
  resolveKitTarget,
  type KitTarget,
  sendKitTest,
  sendKitToTarget,
  syncPost,
} from "../plugins/message_kits/functions/send.js";
import {
  assetUsage,
  countKits,
  countSchedules,
  deleteKitRecord,
  deleteSchedule,
  getKit,
  getPost,
  getPostByMessage,
  getSchedule,
  getVersion,
  insertKit,
  insertPost,
  insertSchedule,
  kitNamesById,
  listKits,
  listLivePosts,
  listRecentPosts,
  listSchedules,
  listVersions,
  pagePosts,
  postCountsByKit,
  scheduleCountsByKit,
  updateKit,
  updatePost,
  updateSchedule,
  type KitAssetRecord,
  type KitPostRecord,
  type KitRecord,
  type KitScheduleRecord,
  type KitVersionRecord,
} from "../plugins/message_kits/functions/store.js";
import { trackDashboardAction } from "./dashboardAudit.js";
import { isDashboardSuperuser } from "./superuser.js";
import { cached } from "./responseCache.js";

// Response shapes are the bot ⇄ website contract for the Message Kits pages; keep them in step
// with the website's src/lib/messageKits.ts.

export type KitPerson = { userId: string; name: string; avatarUrl: string | null };
export type KitSummary = {
  id: number;
  name: string;
  folder: string;
  description: string;
  format: "classic" | "v2";
  version: number;
  archived: boolean;
  updatedAt: string;
  updatedBy: KitPerson | null;
  postCount: number;
  outOfDateCount: number;
  scheduleCount: number;
  preview: { title: string; snippet: string; color: number | null };
};
export type Kit = KitSummary & { document: KitDocument; createdAt: string; createdBy: KitPerson | null };
export type KitPost = {
  id: number;
  kitId: number | null;
  kitName: string | null;
  channelId: string;
  threadId: string | null;
  messageId: string;
  url: string;
  via: "bot" | "webhook";
  version: number;
  outOfDate: boolean;
  status: "live" | "deleted";
  postedBy: KitPerson | null;
  postedAt: string;
  lastSyncedAt: string | null;
};
export type KitSchedule = {
  id: number;
  kitId: number;
  kitName: string;
  channelId: string;
  threadId: string | null;
  repeat: ScheduleRepeat;
  timeOfDay: string;
  timezone: string;
  weekday: number | null;
  monthDay: number | null;
  nextRunAt: string | null;
  replacePrevious: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  createdBy: KitPerson | null;
};
export type KitAsset = { id: string; filename: string; contentType: string; size: number; url: string; createdAt: string };
export type KitVersion = { version: number; savedAt: string; savedBy: KitPerson | null; note: string };

export class KitBridgeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type KitBridgeResponse = { status: number; json: unknown } | { status: number; binary: Buffer; contentType: string };

const ok = (json: Record<string, unknown>): KitBridgeResponse => ({ status: 200, json: { ok: true, ...json } });

// ── People ──────────────────────────────────────────────────────────────────

const MAX_USER_FETCHES = 25;

async function resolvePeople(guild: Guild, ids: Iterable<string | null | undefined>): Promise<Map<string, KitPerson>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  const people = new Map<string, KitPerson>();
  const missing = unique.filter((id) => !guild.members.cache.has(id));
  for (let i = 0; i < missing.length; i += 100) await guild.members.fetch({ user: missing.slice(i, i + 100) }).catch(() => null);
  let fetches = 0;
  for (const id of unique) {
    const member = guild.members.cache.get(id);
    if (member) {
      people.set(id, { userId: id, name: member.displayName, avatarUrl: member.displayAvatarURL({ size: 64, extension: "png" }) });
      continue;
    }
    let user = guild.client.users.cache.get(id) ?? null;
    if (!user && fetches < MAX_USER_FETCHES) {
      fetches += 1;
      user = await guild.client.users.fetch(id).catch(() => null);
    }
    people.set(id, {
      userId: id,
      name: user?.displayName ?? user?.username ?? `Unknown user (${id.slice(-4)})`,
      avatarUrl: user?.displayAvatarURL({ size: 64, extension: "png" }) ?? null,
    });
  }
  return people;
}

const person = (people: Map<string, KitPerson>, id: string | null) => (id ? (people.get(id) ?? null) : null);
const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

// ── Serializers ─────────────────────────────────────────────────────────────

type Counts = { posts: Map<number, { live: number; outOfDate: number }>; schedules: Map<number, number> };

function counts(guildId: string): Counts {
  return { posts: postCountsByKit(guildId), schedules: scheduleCountsByKit(guildId) };
}

function toSummary(kit: KitRecord, doc: KitDocument, c: Counts, people: Map<string, KitPerson>): KitSummary {
  const posts = c.posts.get(kit.id);
  return {
    id: kit.id,
    name: kit.name,
    folder: kit.folder,
    description: kit.description,
    format: doc.format,
    version: kit.version,
    archived: kit.archived,
    updatedAt: kit.updatedAt.toISOString(),
    updatedBy: person(people, kit.updatedBy),
    postCount: posts?.live ?? 0,
    outOfDateCount: posts?.outOfDate ?? 0,
    scheduleCount: c.schedules.get(kit.id) ?? 0,
    preview: kitPreview(doc),
  };
}

async function toKit(guild: Guild, kit: KitRecord): Promise<Kit> {
  const doc = kitDocumentOf(kit);
  const people = await resolvePeople(guild, [kit.createdBy, kit.updatedBy]);
  return {
    ...toSummary(kit, doc, counts(guild.id), people),
    document: doc,
    createdAt: kit.createdAt.toISOString(),
    createdBy: person(people, kit.createdBy),
  };
}

function toPost(guildId: string, post: KitPostRecord, kits: Map<number, Pick<KitRecord, "name" | "version">>, people: Map<string, KitPerson>): KitPost {
  const kit = post.kitId !== null ? kits.get(post.kitId) : undefined;
  return {
    id: post.id,
    kitId: post.kitId,
    kitName: kit?.name ?? null,
    channelId: post.channelId,
    threadId: post.threadId,
    messageId: post.messageId,
    url: postUrl(guildId, post),
    via: post.via === "webhook" ? "webhook" : "bot",
    version: post.kitVersion,
    outOfDate: Boolean(kit && !post.deletedAt && post.kitVersion < kit.version),
    status: post.deletedAt ? "deleted" : "live",
    postedBy: person(people, post.postedBy),
    postedAt: post.postedAt.toISOString(),
    lastSyncedAt: iso(post.lastSyncedAt),
  };
}

async function toPosts(guild: Guild, posts: KitPostRecord[]): Promise<KitPost[]> {
  const kits = new Map<number, Pick<KitRecord, "name" | "version">>();
  for (const id of new Set(posts.map((post) => post.kitId).filter((id): id is number => id !== null))) {
    const kit = getKit(guild.id, id);
    if (kit) kits.set(id, kit);
  }
  const people = await resolvePeople(guild, posts.map((post) => post.postedBy));
  return posts.map((post) => toPost(guild.id, post, kits, people));
}

function toSchedule(schedule: KitScheduleRecord, kitName: string, people: Map<string, KitPerson>): KitSchedule {
  return {
    id: schedule.id,
    kitId: schedule.kitId,
    kitName,
    channelId: schedule.channelId,
    threadId: schedule.threadId,
    repeat: (SCHEDULE_REPEATS as readonly string[]).includes(schedule.repeat) ? (schedule.repeat as ScheduleRepeat) : "none",
    timeOfDay: schedule.timeOfDay,
    timezone: schedule.timezone,
    weekday: schedule.weekday,
    monthDay: schedule.monthDay,
    nextRunAt: schedule.enabled ? iso(schedule.nextRunAt) : null,
    replacePrevious: schedule.replacePrevious,
    enabled: schedule.enabled,
    lastRunAt: iso(schedule.lastRunAt),
    lastError: schedule.lastError,
    createdBy: person(people, schedule.createdBy),
  };
}

async function toSchedules(guild: Guild, schedules: KitScheduleRecord[]): Promise<KitSchedule[]> {
  const names = kitNamesById(guild.id, schedules.map((schedule) => schedule.kitId));
  const people = await resolvePeople(guild, schedules.map((schedule) => schedule.createdBy));
  return schedules.map((schedule) => toSchedule(schedule, names.get(schedule.kitId) ?? "Deleted kit", people));
}

function toAsset(guildId: string, asset: KitAssetRecord): KitAsset {
  return {
    id: asset.id,
    filename: asset.filename,
    contentType: asset.contentType,
    size: asset.size,
    // Bridge-authenticated; the website proxies it for previews.
    url: `/bridge/guilds/${guildId}/message-kits/assets/${asset.id}/file`,
    createdAt: asset.createdAt.toISOString(),
  };
}

async function toVersions(guild: Guild, versions: KitVersionRecord[]): Promise<KitVersion[]> {
  const people = await resolvePeople(guild, versions.map((version) => version.savedBy));
  return versions.map((version) => ({
    version: version.version,
    savedAt: version.savedAt.toISOString(),
    savedBy: person(people, version.savedBy),
    note: version.note,
  }));
}

// ── Input helpers ───────────────────────────────────────────────────────────

function idParam(value: string | undefined, what: string): number {
  const id = Number(value);
  if (!value || !/^\d{1,15}$/.test(value) || !Number.isSafeInteger(id)) throw new KitBridgeError(`Invalid ${what} id.`, 404);
  return id;
}

function text(body: Record<string, unknown>, key: string, max: number, options: { required?: boolean; label?: string } = {}): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required) throw new KitBridgeError(`${options.label ?? key} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new KitBridgeError(`${options.label ?? key} must be text.`);
  const trimmed = value.trim();
  if (options.required && !trimmed) throw new KitBridgeError(`${options.label ?? key} can't be empty.`);
  if (trimmed.length > max) throw new KitBridgeError(`${options.label ?? key} can be at most ${max} characters.`);
  return trimmed;
}

function requireKit(guild: Guild, kitId: number): KitRecord {
  const kit = getKit(guild.id, kitId);
  if (!kit) throw new KitBridgeError("That kit doesn't exist.", 404);
  return kit;
}

async function requireEnabled(guild: Guild): Promise<void> {
  const runtime = await loadKitsRuntime(guild.id);
  if (!runtime.enabled) throw new KitBridgeError("Message Kits is turned off. Turn it on first.", 409);
}

function invalid(issues: KitIssue[], error = "Fix the highlighted parts of this kit first."): KitBridgeError {
  return new KitBridgeError(error, 422, { issues });
}

/**
 * Checks a document against this server: roles, channels, kits and uploads it points at must be
 * this server's (and usable). Returns issues with the same paths as the document validation.
 */
export async function serverIssues(client: Client, guild: Guild, doc: KitDocument): Promise<KitIssue[]> {
  const issues: KitIssue[] = [];
  const add = (path: (string | number)[], message: string) => issues.push({ path: formatIssuePath(path), message });

  for (const { action, path } of listActionRefs(doc)) {
    if (action.type === "role") {
      const grantable = new Set(autoGrantableRoleIds(guild, action.role_ids));
      action.role_ids.forEach((roleId, i) => {
        if (!guild.roles.cache.has(roleId)) add([...path, "role_ids", i], "That role isn't in this server any more.");
        else if (!grantable.has(roleId))
          add([...path, "role_ids", i], "Dreamliner can't give this role: it has staff permissions, is managed by an integration, or is above Dreamliner's highest role.");
      });
    } else if (action.type === "kit") {
      if (action.kit_id && !getKit(guild.id, action.kit_id)) add([...path, "kit_id"], "That kit doesn't exist.");
    } else if (action.type === "form") {
      // Empty in a saved draft; sending parses strictly first, so it can't go out blank.
      const channel = action.channel_id ? await fetchGuildTextChannel(client, guild.id, action.channel_id) : true;
      if (!channel) add([...path, "channel_id"], "Pick a channel in this server that Dreamliner can post in.");
      if (action.ping_role_id === guild.id) add([...path, "ping_role_id"], "Forms can't ping @everyone. Pick a role instead.");
      else if (action.ping_role_id && !guild.roles.cache.has(action.ping_role_id)) add([...path, "ping_role_id"], "That role isn't in this server any more.");
    }
  }

  const refs = listAssetRefs(doc);
  if (refs.length) {
    const assets = new Map(listKitAssets(guild.id).map((asset) => [asset.id, asset]));
    for (const ref of refs) {
      if (!ref.assetId) continue; // a file block still waiting for its upload (draft)
      const asset = assets.get(ref.assetId);
      if (!asset) add(ref.path, "That upload was deleted. Pick another one.");
      else if (ref.image && !isImageAsset(asset)) add(ref.path, "That upload isn't an image.");
    }
  }
  return issues;
}

/** Parses and checks a document from the dashboard, throwing 422 with every issue. Saves accept
 *  drafts (parts may still be empty); `strict` also requires a sendable message. */
async function requireDocument(client: Client, guild: Guild, raw: unknown, strict = false): Promise<KitDocument> {
  const parsed = strict ? parseKitDocument(raw) : parseKitDraft(raw);
  if (!parsed.ok) throw invalid(parsed.issues);
  const issues = await serverIssues(client, guild, parsed.document);
  if (issues.length) throw invalid(issues);
  return parsed.document;
}

// ── Messages from links ─────────────────────────────────────────────────────

const LINK_RE = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})\/?(?:[?#].*)?$/;

/** Whether the dashboard viewer may read messages in `channel` themselves (View Channel + Read
 *  Message History). Importing or linking a message must never reveal a channel they can't see. */
export async function viewerCanReadChannel(guild: Guild, channel: GuildBasedChannel, userId: string): Promise<boolean> {
  if (isDashboardSuperuser(userId)) return true;
  if (guild.ownerId === userId) return true;
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  if (!member) return false;
  const perms = channel.permissionsFor(member);
  return Boolean(perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));
}

/**
 * Resolves a send/schedule target and checks the dashboard user can see it: staff shouldn't be able
 * to post into (or schedule for) channels Discord hides from them. View Channel is enough, so
 * read-only channels like #rules still work.
 */
async function viewerTarget(client: Client, guild: Guild, channelId: string, threadId: string | null, userId: string): Promise<KitTarget> {
  const target = await resolveKitTarget(client, guild, channelId, threadId);
  if (isDashboardSuperuser(userId) || guild.ownerId === userId) return target;
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  const visible = (channel: Channel | null) =>
    Boolean(member && channel && "permissionsFor" in channel && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel));
  const thread = target.threadId ? await fetchGuildChannel(client, guild.id, target.threadId) : null;
  if (!visible(target.channel) || (target.threadId && !visible(thread)))
    throw new KitBridgeError("You need **View Channel** there to send or schedule kits in it.", 403);
  return target;
}

async function messageFromLink(client: Client, guild: Guild, link: unknown, userId: string): Promise<Message> {
  if (typeof link !== "string") throw new KitBridgeError("Paste a message link.");
  const match = LINK_RE.exec(link.trim());
  if (!match) throw new KitBridgeError("That isn't a Discord message link (right-click a message → Copy Message Link).");
  if (match[1] !== guild.id) throw new KitBridgeError("That message is in a different server.", 403);
  const channel = await fetchGuildChannel(client, guild.id, match[2]);
  if (!channel?.isTextBased() || channel.isDMBased()) throw new KitBridgeError("Dreamliner can't see that channel.", 404);
  if (!(await viewerCanReadChannel(guild, channel, userId)))
    throw new KitBridgeError("You need **View Channel** and **Read Message History** in that channel to use its messages.", 403);
  const me = guild.members.me;
  if (me && "permissionsFor" in channel) {
    const perms = channel.permissionsFor(me);
    if (perms && !perms.has(PermissionFlagsBits.ReadMessageHistory)) throw new KitBridgeError("Dreamliner needs **Read Message History** in that channel.", 403);
  }
  const message = await channel.messages.fetch(match[3]!).catch(() => null);
  if (!message) throw new KitBridgeError("Couldn't find that message.", 404);
  return message;
}

/** Whether Dreamliner can edit a message: its own, or one from a webhook it owns. */
async function adoptability(client: Client, message: Message): Promise<{ adoptable: boolean; via: "bot" | "webhook"; webhookId: string | null }> {
  if (!message.webhookId) return { adoptable: message.author.id === client.user?.id, via: "bot", webhookId: null };
  if (message.applicationId && message.applicationId === client.user?.id) return { adoptable: true, via: "webhook", webhookId: message.webhookId };
  if (isOwnWebhookId(message.webhookId)) return { adoptable: true, via: "webhook", webhookId: message.webhookId };
  const target = webhookTarget(message.channel);
  const me = message.guild?.members.me;
  if (target && me && target.parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
    const hooks = await target.parent.fetchWebhooks().catch(() => null);
    const hook = hooks?.find((h) => h.id === message.webhookId);
    if (hook && hook.owner?.id === me.id && hook.token) return { adoptable: true, via: "webhook", webhookId: hook.id };
  }
  return { adoptable: false, via: "webhook", webhookId: message.webhookId };
}

function messageData(message: Message): Record<string, unknown> {
  return {
    content: message.content,
    embeds: message.embeds.map((embed) => embed.toJSON()),
    components: message.components.map((component) => component.toJSON()),
    flags: message.flags.bitfield,
    attachments: [...message.attachments.values()].map((attachment) => ({ id: attachment.id })),
    ...(message.webhookId ? { username: message.author.username, avatar_url: message.author.displayAvatarURL({ extension: "png", size: 256 }) } : {}),
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

const syncing = new Set<string>();

async function listRoute(guild: Guild, query: URLSearchParams): Promise<KitBridgeResponse> {
  const kits = listKits(guild.id);
  const search = (query.get("search") ?? "").trim().toLowerCase();
  const folder = query.get("folder");
  const archived = query.get("archived") === "1";
  const filtered = kits.filter(
    (kit) =>
      kit.archived === archived &&
      (folder === null || folder === "" || kit.folder === folder) &&
      (!search || kit.name.toLowerCase().includes(search) || kit.description.toLowerCase().includes(search) || kit.folder.toLowerCase().includes(search)),
  );
  const c = counts(guild.id);
  const people = await resolvePeople(guild, filtered.map((kit) => kit.updatedBy));
  const usage = assetUsage(guild.id);
  return ok({
    kits: filtered.map((kit) => toSummary(kit, kitDocumentOf(kit), c, people)),
    folders: [...new Set(kits.map((kit) => kit.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    limits: KIT_LIMITS,
    usage: { kits: kits.length, schedules: countSchedules(guild.id), assets: usage.count, assetBytes: usage.bytes },
  });
}

async function kitRoutes(client: Client, guild: Guild, method: string, rest: string[], body: Record<string, unknown>, userId: string): Promise<KitBridgeResponse> {
  const audit = (title: string, summary: string, payload: Record<string, unknown> = {}) =>
    trackDashboardAction(client, guild.id, userId, { eventType: "dashboard_config", title, summary, details: [], payload });

  if (rest.length === 0) {
    if (method === "GET") throw new KitBridgeError("Not found", 404);
    if (method !== "POST") throw new KitBridgeError("Method not allowed", 405);
    if (countKits(guild.id) >= KIT_LIMITS.kits) throw new KitBridgeError(`A server can have ${KIT_LIMITS.kits} kits. Delete some you no longer use first.`, 409);
    const name = text(body, "name", KIT_LIMITS.kitName, { required: true, label: "Name" })!;
    const folder = text(body, "folder", KIT_LIMITS.folderName, { label: "Folder" }) ?? "";
    const description = text(body, "description", KIT_LIMITS.description, { label: "Description" }) ?? "";
    const doc = await requireDocument(client, guild, body.document);
    const now = new Date();
    const kit = insertKit({ guildId: guild.id, name, folder, description, document: JSON.stringify(doc), createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now, note: "Created" });
    audit("Message kit created", `Message kit "${kit.name}" was created.`, { kitId: kit.id });
    return ok({ kit: await toKit(guild, kit) });
  }

  const kit = requireKit(guild, idParam(rest[0], "kit"));
  const action = rest[1];

  if (!action) {
    if (method === "GET") {
      const posts = await toPosts(guild, listRecentPosts(guild.id, kit.id, 100));
      return ok({ kit: await toKit(guild, kit), posts, schedules: await toSchedules(guild, listSchedules(guild.id, kit.id)) });
    }
    if (method === "PATCH") {
      const patch: Parameters<typeof updateKit>[1] = {};
      const name = text(body, "name", KIT_LIMITS.kitName, { label: "Name" });
      if (name !== undefined) {
        if (!name) throw new KitBridgeError("Name can't be empty.");
        patch.name = name;
      }
      const folder = text(body, "folder", KIT_LIMITS.folderName, { label: "Folder" });
      if (folder !== undefined) patch.folder = folder;
      const description = text(body, "description", KIT_LIMITS.description, { label: "Description" });
      if (description !== undefined) patch.description = description;
      if (body.archived !== undefined) {
        if (typeof body.archived !== "boolean") throw new KitBridgeError("archived must be true or false.");
        patch.archived = body.archived;
      }
      if (body.document !== undefined) patch.document = JSON.stringify(await requireDocument(client, guild, body.document));
      patch.note = text(body, "note", 200, { label: "Note" }) ?? "";
      const updated = updateKit(kit, patch, userId);
      const changed = updated.version !== kit.version;
      audit("Message kit updated", `Message kit "${updated.name}" was ${changed ? `saved as version ${updated.version}` : "updated"}.`, { kitId: kit.id, version: updated.version });
      return ok({ kit: await toKit(guild, updated) });
    }
    if (method === "DELETE") {
      let deleted = 0;
      if (body.deletePosts === true) {
        const posts = listLivePosts(guild.id, kit.id);
        const results = await mapLimit(posts, 2, (post) => deletePost(client, guild, post, kit.name).then(() => true, () => false));
        deleted = results.filter(Boolean).length;
      }
      deleteKitRecord(guild.id, kit.id);
      audit("Message kit deleted", `Message kit "${kit.name}" was deleted${deleted ? ` with ${deleted} sent ${deleted === 1 ? "copy" : "copies"}` : ""}.`, { kitId: kit.id });
      return ok({});
    }
    throw new KitBridgeError("Method not allowed", 405);
  }

  if (action === "duplicate" && method === "POST" && rest.length === 2) {
    if (countKits(guild.id) >= KIT_LIMITS.kits) throw new KitBridgeError(`A server can have ${KIT_LIMITS.kits} kits. Delete some you no longer use first.`, 409);
    const now = new Date();
    const suffix = " (copy)";
    const copy = insertKit({
      guildId: guild.id,
      name: `${kit.name.slice(0, KIT_LIMITS.kitName - suffix.length)}${suffix}`,
      folder: kit.folder,
      description: kit.description,
      document: kit.document,
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
      note: `Copied from "${kit.name}"`.slice(0, 200),
    });
    audit("Message kit duplicated", `Message kit "${kit.name}" was duplicated.`, { kitId: copy.id, from: kit.id });
    return ok({ kit: await toKit(guild, copy) });
  }

  if (action === "versions") {
    if (rest.length === 2 && method === "GET") return ok({ versions: await toVersions(guild, listVersions(kit.id)) });
    const version = getVersion(kit.id, idParam(rest[2], "version"));
    if (!version) throw new KitBridgeError("That version isn't kept any more.", 404);
    if (rest.length === 3 && method === "GET") {
      const [entry] = await toVersions(guild, [version]);
      return ok({ version: entry, document: kitDocumentOf(version) });
    }
    if (rest.length === 4 && rest[3] === "restore" && method === "POST") {
      const updated = updateKit(kit, { document: version.document, note: `Restored version ${version.version}` }, userId);
      audit("Message kit restored", `Message kit "${kit.name}" was restored to version ${version.version}.`, { kitId: kit.id, version: version.version });
      return ok({ kit: await toKit(guild, updated) });
    }
    throw new KitBridgeError("Not found", 404);
  }

  if (method !== "POST" || rest.length !== 2) throw new KitBridgeError("Not found", 404);

  if (action === "send") {
    await requireEnabled(guild);
    const parsed = parseKitDocument(JSON.parse(kit.document));
    if (!parsed.ok) throw invalid(parsed.issues, "Fix this kit before sending it.");
    const issues = await serverIssues(client, guild, parsed.document);
    if (issues.length) throw invalid(issues, "Fix this kit before sending it.");
    const raw = Array.isArray(body.targets) ? body.targets : [];
    const seen = new Set<string>();
    const targets: { channelId: string; threadId: string | null }[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const channelId = (entry as { channelId?: unknown }).channelId;
      const threadId = (entry as { threadId?: unknown }).threadId;
      if (typeof channelId !== "string") continue;
      const target = { channelId, threadId: typeof threadId === "string" && threadId ? threadId : null };
      const key = `${target.channelId}:${target.threadId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
    if (!targets.length) throw new KitBridgeError("Pick at least one channel.");
    if (targets.length > KIT_LIMITS.targetsPerSend) throw new KitBridgeError(`Send to at most ${KIT_LIMITS.targetsPerSend} channels at once.`);
    const outcomes = await mapLimit(targets, 2, async (target) => {
      try {
        await viewerTarget(client, guild, target.channelId, target.threadId, userId);
        const post = await sendKitToTarget(client, guild, kit, { ...target, userId, reason: "dashboard" });
        return { ...target, ok: true as const, post };
      } catch (error) {
        return { ...target, ok: false as const, error: describeDiscordError(error) };
      }
    });
    const sent = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.post!);
    const serialized = new Map((await toPosts(guild, sent)).map((post) => [post.id, post]));
    const results = outcomes.map((outcome) =>
      outcome.ok
        ? { channelId: outcome.channelId, threadId: outcome.threadId, ok: true, post: serialized.get(outcome.post.id) }
        : { channelId: outcome.channelId, threadId: outcome.threadId, ok: false, error: outcome.error },
    );
    if (sent.length) audit("Message kit sent", `Message kit "${kit.name}" was sent to ${sent.length} ${sent.length === 1 ? "channel" : "channels"}.`, { kitId: kit.id, posts: sent.map((post) => post.id) });
    return ok({ results });
  }

  if (action === "sync") {
    await requireEnabled(guild);
    const live = listLivePosts(guild.id, kit.id);
    let posts: KitPostRecord[];
    if (Array.isArray(body.postIds)) {
      const wanted = new Set(body.postIds.filter((id): id is number => typeof id === "number"));
      posts = live.filter((post) => wanted.has(post.id));
    } else {
      posts = live.filter((post) => post.kitVersion < kit.version);
    }
    posts = posts.slice(0, 100);
    if (syncing.has(guild.id)) throw new KitBridgeError("An update is already running for this server. Try again when it finishes.", 409);
    syncing.add(guild.id);
    try {
      const outcomes = await mapLimit(posts, 2, (post) => syncPost(client, guild, kit, post));
      const results = outcomes.map((outcome, i) =>
        outcome.ok ? { postId: posts[i]!.id, ok: true, ...(outcome.reposted ? { reposted: true } : {}) } : { postId: posts[i]!.id, ok: false, error: outcome.error },
      );
      const updated = outcomes.filter((outcome) => outcome.ok).length;
      if (posts.length) audit("Message kit copies updated", `${updated} of ${posts.length} copies of "${kit.name}" were updated.`, { kitId: kit.id });
      return ok({ results });
    } finally {
      syncing.delete(guild.id);
    }
  }

  if (action === "test") {
    const parsed = parseKitDocument(JSON.parse(kit.document));
    if (!parsed.ok) throw invalid(parsed.issues, "Fix this kit before sending it.");
    await sendKitTest(client, guild, kit, userId);
    return ok({});
  }

  throw new KitBridgeError("Not found", 404);
}

async function postRoutes(client: Client, guild: Guild, method: string, rest: string[], query: URLSearchParams, body: Record<string, unknown>, userId: string): Promise<KitBridgeResponse> {
  if (rest.length === 0 && method === "GET") {
    const page = Math.max(1, Math.floor(Number(query.get("page") ?? 1)) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.get("pageSize") ?? 25)) || 25));
    const kitParam = query.get("kitId");
    const kitId = kitParam ? idParam(kitParam, "kit") : null;
    const { rows, total } = pagePosts(guild.id, kitId, page, pageSize);
    return ok({ page, pageSize, total, posts: await toPosts(guild, rows) });
  }
  if (method !== "POST" || rest.length !== 1) throw new KitBridgeError("Not found", 404);
  await requireEnabled(guild);

  if (rest[0] === "adopt") {
    const kit = requireKit(guild, typeof body.kitId === "number" ? body.kitId : idParam(String(body.kitId ?? ""), "kit"));
    const message = await messageFromLink(client, guild, body.link, userId);
    const how = await adoptability(client, message);
    if (!how.adoptable) throw new KitBridgeError("Only messages sent by Dreamliner (or its own webhooks) can be linked to a kit, since nothing else can be edited by it.", 403);
    const channel = message.channel;
    const channelId = channel.isThread() ? (channel.parentId ?? channel.id) : channel.id;
    const threadId = channel.isThread() ? channel.id : null;
    const format = message.flags.has(MessageFlags.IsComponentsV2) ? "v2" : "classic";
    const existing = getPostByMessage(message.id);
    const now = new Date();
    // Version 0: always out of date, so "Update" edits it into the kit.
    const post = existing
      ? (updatePost(existing.id, { kitId: kit.id, kitVersion: 0, deletedAt: null, via: how.via, webhookId: how.webhookId, format }) ?? existing)
      : insertPost({
          guildId: guild.id,
          kitId: kit.id,
          channelId,
          threadId,
          messageId: message.id,
          via: how.via,
          webhookId: how.webhookId,
          format,
          kitVersion: 0,
          postedBy: userId,
          postedAt: message.createdAt ?? now,
          lastSyncedAt: null,
          deletedAt: null,
        });
    trackDashboardAction(client, guild.id, userId, {
      eventType: "dashboard_config",
      title: "Message linked to a kit",
      summary: `A message in <#${threadId ?? channelId}> was linked to the kit "${kit.name}".`,
      details: [],
      payload: { kitId: kit.id, postId: post.id },
    });
    const [serialized] = await toPosts(guild, [post]);
    return ok({ post: serialized });
  }

  const post = getPost(guild.id, idParam(rest[0], "post"));
  if (!post) throw new KitBridgeError("That copy doesn't exist.", 404);
  const kitName = post.kitId !== null ? (getKit(guild.id, post.kitId)?.name ?? null) : null;
  let updated: KitPostRecord;
  if (body.action === "delete") {
    updated = await deletePost(client, guild, post, kitName);
    trackDashboardAction(client, guild.id, userId, { eventType: "dashboard_config", title: "Message kit copy deleted", summary: `A sent copy${kitName ? ` of "${kitName}"` : ""} was deleted.`, details: [], payload: { postId: post.id } });
  } else if (body.action === "detach") {
    updated = updatePost(post.id, { kitId: null }) ?? post;
    trackDashboardAction(client, guild.id, userId, { eventType: "dashboard_config", title: "Message kit copy detached", summary: `A sent copy${kitName ? ` of "${kitName}"` : ""} was detached from its kit.`, details: [], payload: { postId: post.id } });
  } else if (body.action === "refresh") {
    updated = await refreshPost(client, guild, post);
  } else {
    throw new KitBridgeError("action must be delete, detach or refresh.");
  }
  const [serialized] = await toPosts(guild, [updated]);
  return ok({ post: serialized });
}

type ScheduleInput = {
  repeat: ScheduleRepeat;
  timeOfDay: string;
  timezone: string;
  weekday: number | null;
  monthDay: number | null;
  date: string | null;
};

function scheduleInput(body: Record<string, unknown>, existing?: KitScheduleRecord): ScheduleInput {
  const pick = <T>(key: string, fallback: T): T => (body[key] === undefined ? fallback : (body[key] as T));
  let date = typeof body.date === "string" ? body.date : null;
  if (!date && existing?.nextRunAt) {
    const p = zonedParts(existing.nextRunAt.getTime(), existing.timezone);
    date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  }
  const input: ScheduleInput = {
    repeat: pick("repeat", (existing?.repeat ?? "none") as ScheduleRepeat),
    timeOfDay: pick("timeOfDay", existing?.timeOfDay ?? ""),
    timezone: pick("timezone", existing?.timezone ?? ""),
    weekday: pick("weekday", existing?.weekday ?? null),
    monthDay: pick("monthDay", existing?.monthDay ?? null),
    date,
  };
  const check = checkScheduleRule(input);
  if (!check.ok) throw new KitBridgeError(check.error);
  return {
    ...input,
    weekday: input.repeat === "weekly" ? input.weekday : null,
    monthDay: input.repeat === "monthly" ? input.monthDay : null,
  };
}

function firstRun(input: ScheduleInput): Date {
  const next = nextRunAt(input, Date.now());
  if (next === null) throw new KitBridgeError("Couldn't work out when that runs.");
  if (input.repeat === "none" && next <= Date.now() + 30_000) throw new KitBridgeError("That time is in the past. Pick a later one.");
  return new Date(next);
}

async function scheduleRoutes(client: Client, guild: Guild, method: string, rest: string[], body: Record<string, unknown>, userId: string): Promise<KitBridgeResponse> {
  const audit = (title: string, summary: string, payload: Record<string, unknown>) =>
    trackDashboardAction(client, guild.id, userId, { eventType: "dashboard_config", title, summary, details: [], payload });

  if (rest.length === 0) {
    if (method === "GET") return ok({ schedules: await toSchedules(guild, listSchedules(guild.id)) });
    if (method !== "POST") throw new KitBridgeError("Method not allowed", 405);
    await requireEnabled(guild);
    if (countSchedules(guild.id) >= KIT_LIMITS.schedules) throw new KitBridgeError(`A server can have ${KIT_LIMITS.schedules} schedules. Delete some first.`, 409);
    const kit = requireKit(guild, typeof body.kitId === "number" ? body.kitId : idParam(String(body.kitId ?? ""), "kit"));
    if (typeof body.channelId !== "string") throw new KitBridgeError("Pick a channel.");
    const threadId = typeof body.threadId === "string" && body.threadId ? body.threadId : null;
    const target = await viewerTarget(client, guild, body.channelId, threadId, userId);
    const input = scheduleInput(body);
    const schedule = insertSchedule({
      guildId: guild.id,
      kitId: kit.id,
      channelId: target.channelId,
      threadId: target.threadId,
      nextRunAt: firstRun(input),
      repeat: input.repeat,
      timeOfDay: input.timeOfDay,
      timezone: input.timezone,
      weekday: input.weekday,
      monthDay: input.monthDay,
      replacePrevious: body.replacePrevious === true,
      lastPostId: null,
      enabled: true,
      lastRunAt: null,
      lastError: null,
      failCount: 0,
      createdBy: userId,
      createdAt: new Date(),
    });
    audit("Message kit scheduled", `Message kit "${kit.name}" was scheduled (${input.repeat === "none" ? "once" : input.repeat}).`, { kitId: kit.id, scheduleId: schedule.id });
    const [serialized] = await toSchedules(guild, [schedule]);
    return ok({ schedule: serialized });
  }

  const schedule = getSchedule(guild.id, idParam(rest[0], "schedule"));
  if (!schedule) throw new KitBridgeError("That schedule doesn't exist.", 404);

  if (rest.length === 2 && rest[1] === "run" && method === "POST") {
    await requireEnabled(guild);
    try {
      const post = await runScheduleNow(client, guild, schedule, userId);
      audit("Message kit schedule run", `A schedule was run now.`, { scheduleId: schedule.id, postId: post.id });
      const [serialized] = await toPosts(guild, [post]);
      return ok({ post: serialized });
    } catch (error) {
      updateSchedule(schedule.id, { lastError: describeDiscordError(error) });
      throw error;
    }
  }
  if (rest.length !== 1) throw new KitBridgeError("Not found", 404);

  if (method === "DELETE") {
    deleteSchedule(guild.id, schedule.id);
    audit("Message kit schedule deleted", "A Message Kits schedule was deleted.", { scheduleId: schedule.id });
    return ok({});
  }
  if (method !== "PATCH") throw new KitBridgeError("Method not allowed", 405);

  const patch: Partial<KitScheduleRecord> = {};
  if (body.kitId !== undefined) patch.kitId = requireKit(guild, typeof body.kitId === "number" ? body.kitId : idParam(String(body.kitId), "kit")).id;
  if (body.channelId !== undefined || body.threadId !== undefined) {
    const channelId = typeof body.channelId === "string" ? body.channelId : schedule.channelId;
    const threadId = body.threadId === undefined ? (body.channelId === undefined ? schedule.threadId : null) : typeof body.threadId === "string" && body.threadId ? body.threadId : null;
    const target = await viewerTarget(client, guild, channelId, threadId, userId);
    patch.channelId = target.channelId;
    patch.threadId = target.threadId;
  }
  if (body.replacePrevious !== undefined) patch.replacePrevious = body.replacePrevious === true;
  const timing = ["repeat", "timeOfDay", "timezone", "weekday", "monthDay", "date"].some((key) => body[key] !== undefined);
  const enabling = body.enabled === true && !schedule.enabled;
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;
  if (timing || enabling) {
    const input = scheduleInput(body, schedule);
    Object.assign(patch, { repeat: input.repeat, timeOfDay: input.timeOfDay, timezone: input.timezone, weekday: input.weekday, monthDay: input.monthDay });
    if (patch.enabled ?? schedule.enabled) patch.nextRunAt = firstRun(input);
  }
  if (enabling) Object.assign(patch, { failCount: 0, lastError: null });
  const updated = updateSchedule(schedule.id, patch) ?? schedule;
  audit("Message kit schedule updated", "A Message Kits schedule was updated.", { scheduleId: schedule.id });
  const [serialized] = await toSchedules(guild, [updated]);
  return ok({ schedule: serialized });
}

async function assetRoutes(client: Client, guild: Guild, method: string, rest: string[], body: Record<string, unknown>, userId: string): Promise<KitBridgeResponse> {
  if (rest.length === 0) {
    if (method === "GET") return ok({ assets: listKitAssets(guild.id).map((asset) => toAsset(guild.id, asset)), usage: assetUsage(guild.id) });
    if (method !== "POST") throw new KitBridgeError("Method not allowed", 405);
    if (typeof body.dataBase64 !== "string" || !body.dataBase64) throw new KitBridgeError("dataBase64 is required.");
    const bytes = Buffer.from(body.dataBase64.replace(/^data:[^;,]*;base64,/, ""), "base64");
    const filename = typeof body.filename === "string" ? body.filename : "file";
    const contentType = typeof body.contentType === "string" ? body.contentType : "";
    const asset = saveKitAsset(guild.id, userId, { filename, contentType, bytes });
    trackDashboardAction(client, guild.id, userId, {
      eventType: "dashboard_config",
      title: "Message kit file uploaded",
      summary: `"${asset.filename}" was uploaded to the Message Kits library.`,
      details: [],
      payload: { assetId: asset.id },
    });
    return ok({ asset: toAsset(guild.id, asset) });
  }
  const assetId = rest[0]!;
  if (!/^[a-f0-9]{16}$/.test(assetId)) throw new KitBridgeError("That file doesn't exist.", 404);
  const asset = listKitAssets(guild.id).find((entry) => entry.id === assetId);
  if (!asset) throw new KitBridgeError("That file doesn't exist.", 404);

  if (rest.length === 2 && rest[1] === "file" && method === "GET") {
    const bytes = readKitAsset(guild.id, asset.id);
    if (!bytes) throw new KitBridgeError("That file is missing.", 404);
    return { status: 200, binary: bytes, contentType: asset.contentType };
  }
  if (rest.length === 1 && method === "DELETE") {
    const using = listKits(guild.id).filter((kit) => referencedAssetIds(kitDocumentOf(kit)).includes(asset.id));
    if (using.length) throw new KitBridgeError("This file is used by some kits. Remove it from them first.", 409, { kits: using.map((kit) => kit.name) });
    deleteKitAsset(guild.id, asset.id);
    trackDashboardAction(client, guild.id, userId, {
      eventType: "dashboard_config",
      title: "Message kit file deleted",
      summary: `"${asset.filename}" was deleted from the Message Kits library.`,
      details: [],
      payload: { assetId: asset.id },
    });
    return ok({});
  }
  throw new KitBridgeError("Not found", 404);
}

async function fetchAppEmojis(client: Client) {
  const fetched = await client.application?.emojis.fetch().catch(() => null);
  if (!fetched) return [];
  return [...fetched.values()].map((emoji) => ({ id: emoji.id, name: emoji.name ?? "emoji", animated: Boolean(emoji.animated) }));
}

const WEBHOOK_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

async function contextRoute(client: Client, guild: Guild): Promise<KitBridgeResponse> {
  const me = guild.members.me;
  const canManageWebhooksIn = me
    ? [...guild.channels.cache.values()]
        .filter((channel) => WEBHOOK_CHANNEL_TYPES.has(channel.type) && channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks))
        .map((channel) => channel.id)
    : [];
  return ok({
    botName: me?.displayName ?? client.user?.username ?? "Dreamliner",
    botAvatarUrl: (me ?? client.user)?.displayAvatarURL({ extension: "png", size: 128 }) ?? "",
    guildName: guild.name,
    guildIconUrl: guild.iconURL({ extension: "png", size: 128 }),
    appEmojis: await cached("message-kits:app-emojis", 10 * 60_000, () => fetchAppEmojis(client)),
    canManageWebhooksIn,
  });
}

async function importRoute(client: Client, guild: Guild, body: Record<string, unknown>, userId: string): Promise<KitBridgeResponse> {
  try {
    if (typeof body.link === "string" && body.link.trim()) {
      const message = await messageFromLink(client, guild, body.link, userId);
      const result = documentFromMessageData(messageData(message));
      const how = await adoptability(client, message);
      return ok({ document: result.document, source: { channelId: message.channelId, messageId: message.id, adoptable: how.adoptable }, warnings: result.warnings });
    }
    if (typeof body.json === "string" && body.json.trim()) {
      if (body.json.length > 500_000) throw new KitBridgeError("That JSON is too large.");
      const result = importKitJson(body.json);
      return ok({ document: result.document, source: null, warnings: result.warnings });
    }
  } catch (error) {
    if (error instanceof KitImportError) throw new KitBridgeError(error.message);
    throw error;
  }
  throw new KitBridgeError("Paste a message link or some JSON.");
}

/**
 * Entry point from dashboardBridge.ts for `/bridge/guilds/:guildId/message-kits/<segments>`.
 * The caller has already checked the user may manage the server.
 */
export async function handleMessageKitsBridge(
  client: Client,
  guild: Guild,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
  userId: string,
): Promise<KitBridgeResponse> {
  try {
    const [area, ...rest] = segments;
    if (area === "kits") return rest.length === 0 && method === "GET" ? await listRoute(guild, query) : await kitRoutes(client, guild, method, rest, body, userId);
    if (area === "validate" && method === "POST" && rest.length === 0) {
      await requireDocument(client, guild, body.document, true);
      return { status: 200, json: { ok: true } };
    }
    if (area === "posts") return await postRoutes(client, guild, method, rest, query, body, userId);
    if (area === "import" && method === "POST" && rest.length === 0) return await importRoute(client, guild, body, userId);
    if (area === "schedules") return await scheduleRoutes(client, guild, method, rest, body, userId);
    if (area === "assets") return await assetRoutes(client, guild, method, rest, body, userId);
    if (area === "context" && method === "GET" && rest.length === 0) return await contextRoute(client, guild);
    throw new KitBridgeError("Not found", 404);
  } catch (error) {
    if (error instanceof KitBridgeError) return { status: error.status, json: { error: error.message, ...error.extra } };
    if (error instanceof KitAssetError) return { status: error.status, json: { error: error.message } };
    if (error instanceof KitSendError) {
      if (error.path) return { status: 422, json: { error: error.message, issues: [{ path: error.path, message: error.message }] } };
      return { status: error.status, json: { error: error.message } };
    }
    if (error instanceof SyntaxError) return { status: 400, json: { error: "A stored kit couldn't be read." } };
    // Discord rejected something (render errors carry a path too).
    const message = describeDiscordError(error);
    const path = (error as { path?: unknown })?.path;
    if (typeof path === "string" && path) return { status: 422, json: { error: message, issues: [{ path, message }] } };
    if ((error as { code?: unknown })?.code !== undefined) return { status: 400, json: { error: message } };
    throw error;
  }
}
