import type { Guild } from "discord.js";
import { isDreamlinerOneActive } from "./dreamlinerOne.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import { computeUsage, type FileUsage } from "../core/serverFiles/references.js";
import {
  cleanDisplayName,
  cleanFolder,
  deleteServerFile,
  FILE_ID_RE,
  getServerFile,
  listServerFiles,
  readServerFile,
  replaceServerFile,
  saveServerFile,
  SERVER_FILES_QUOTA,
  serverFileUrl,
  ServerFileError,
  serverFilesUsage,
  touchServerFile,
  updateServerFile,
  type SaveOptions,
  type ServerFile,
} from "../core/serverFiles/store.js";
import {
  UPLOAD_LIMITS_TEXT,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FRAMES,
  UPLOAD_MAX_SIDE,
  UploadValidationError,
} from "../core/serverFiles/validate.js";

/**
 * Server Files (bridge side). Everything under /bridge/guilds/:guildId/files:
 *
 *   GET    ?userId=[&plugin=]                 the library: files (with where each is used), usage, limits
 *   POST   ?userId=[&plugin=]  { filename, dataBase64, folder? }   upload (fills a field / adds to the library)
 *   GET    /:id?userId=                       one file, with uploader and usage
 *   PATCH  /:id?userId=  { displayName?, folder? }                rename / move   (Manage Server)
 *   DELETE /:id?userId=[&force=1]             delete; 409 + where it's used unless force   (Manage Server)
 *   POST   /:id/replace?userId=  { filename, dataBase64 }         new bytes, same link   (Manage Server)
 *   POST   /:id/touch?userId=[&plugin=]       picked in a field: updates "last used"
 *   POST   /bulk?userId=  { action: "delete" | "move", ids, folder?, force? }   (Manage Server)
 *   GET    /raw/:id.:ext                      the bytes (no user: the website serves them to Discord)
 *
 * Who: Manage Server for everything; members with a plugin's `can_manage` can also list, upload
 * and pick while working on that plugin's page (`plugin=`). Deleting, renaming and replacing
 * change what other pages show, so they stay Manage Server only.
 */

/** Abuse limits on top of the bridge's per-minute upload bucket (rateLimit.ts). */
export const FILE_UPLOAD_LIMITS = { perUserHour: 60, perGuildDay: 300 } as const;
let userHourly = new SlidingWindowLimiter(FILE_UPLOAD_LIMITS.perUserHour, 60 * 60_000);
let guildDaily = new SlidingWindowLimiter(FILE_UPLOAD_LIMITS.perGuildDay, 24 * 60 * 60_000);

export function resetFileUploadLimitsForTests(): void {
  userHourly = new SlidingWindowLimiter(FILE_UPLOAD_LIMITS.perUserHour, 60 * 60_000);
  guildDaily = new SlidingWindowLimiter(FILE_UPLOAD_LIMITS.perGuildDay, 24 * 60 * 60_000);
}

/** Counts one upload; an error message when the user or server is over its limit. */
function takeUploadSlot(guildId: string, userId: string): string | null {
  if (!userHourly.check(userId)) return `You've uploaded ${FILE_UPLOAD_LIMITS.perUserHour} files in the last hour. Try again later.`;
  if (!guildDaily.check(guildId)) return `This server has uploaded ${FILE_UPLOAD_LIMITS.perGuildDay} files today. Try again tomorrow.`;
  userHourly.take(userId);
  guildDaily.take(guildId);
  return null;
}

export type FilesResult =
  | { status: number; json: unknown }
  | { status: number; binary: Buffer; headers: Record<string, string> };

const SOURCE_LABELS: Record<string, string> = {
  upload: "Server Files",
  message_kits: "Message Kits",
  welcome: "Welcomer",
  passport: "Passport",
  appeals: "Appeals",
  team_kiosk: "Team Control",
  characters: "Characters",
};

/** Headers for a served file: exact image type, never sniffed, never rendered as a page. */
export function fileResponseHeaders(file: Pick<ServerFile, "contentType" | "sha256" | "displayName">, size: number): Record<string, string> {
  return {
    "Content-Type": file.contentType,
    "Content-Length": String(size),
    // Not immutable: replacing a file keeps its link, so caches must pick up new bytes within the hour.
    "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    ETag: `"${file.sha256.slice(0, 32)}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": `inline; filename="${file.displayName.replace(/[^\w.-]/g, "_").slice(0, 80)}"`,
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}

type Quota = { count: number; bytes: number; one: boolean };

async function quotaFor(guildId: string): Promise<Quota> {
  const one = await isDreamlinerOneActive(guildId).catch(() => false);
  return { ...(one ? SERVER_FILES_QUOTA.one : SERVER_FILES_QUOTA.free), one };
}

function view(file: ServerFile, usedIn?: FileUsage[]) {
  return {
    id: file.id,
    url: serverFileUrl(file),
    name: file.displayName,
    originalName: file.originalName,
    contentType: file.contentType,
    extension: file.extension,
    size: file.size,
    width: file.width,
    height: file.height,
    frames: file.frames,
    folder: file.folder,
    source: file.source,
    sourceLabel: SOURCE_LABELS[file.source] ?? file.source,
    createdBy: file.createdBy,
    createdAt: new Date(file.createdAt).toISOString(),
    updatedAt: new Date(file.updatedAt).toISOString(),
    lastUsedAt: file.lastUsedAt ? new Date(file.lastUsedAt).toISOString() : null,
    ...(usedIn ? { usedIn } : {}),
  };
}

/** Base64 for at most `maxBytes` of data; null when malformed. */
export function decodeFileBase64(raw: unknown, maxBytes = UPLOAD_MAX_BYTES): Buffer | "too_big" | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/^data:[\w.+-]+\/[\w.+-]+;base64,/, "").replace(/\s+/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  if (Math.floor((cleaned.length * 3) / 4) > maxBytes + 3) return "too_big";
  return Buffer.from(cleaned, "base64");
}

function errorResult(error: unknown): FilesResult {
  if (error instanceof UploadValidationError || error instanceof ServerFileError) {
    return { status: error.status, json: { ok: false, error: error.message } };
  }
  throw error;
}

const TOO_BIG = `That file is too big, the limit is ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`;

export async function handleFilesRequest(input: {
  guild: Guild;
  method: string;
  /** Path after /files, split on "/" (empty for the library). */
  rest: string[];
  query: URLSearchParams;
  userId: string | null;
  managesServer: (userId: string) => Promise<boolean>;
  /** Whether the user has this plugin's `can_manage` (for uploads from that plugin's page). */
  pluginManager: (userId: string, plugin: string) => Promise<boolean>;
  readJson: () => Promise<Record<string, unknown> | null>;
  /** Tests pass a fixed quota and content check. */
  quota?: (guildId: string) => Promise<Quota>;
  contentCheck?: SaveOptions["contentCheck"];
}): Promise<FilesResult> {
  const { guild, method, rest, query } = input;

  if (rest[0] === "raw") {
    if (method !== "GET" && method !== "HEAD") return { status: 405, json: { error: "Method not allowed" } };
    const match = rest.length === 2 ? /^([a-f0-9]{32})\.(png|jpg|gif|webp)$/.exec(rest[1]!) : null;
    const found = match ? readServerFile(guild.id, match[1]!, match[2]!) : null;
    if (!found) return { status: 404, json: { error: "Not found" } };
    return { status: 200, binary: found.bytes, headers: fileResponseHeaders(found.file, found.bytes.length) };
  }

  const userId = input.userId;
  if (!userId || !/^\d{15,22}$/.test(userId)) return { status: 400, json: { ok: false, error: "userId is required" } };
  const manager = await input.managesServer(userId);
  const plugin = query.get("plugin");
  const canUse = manager || (plugin !== null && /^[a-z_]{2,40}$/.test(plugin) && (await input.pluginManager(userId, plugin)));
  if (!canUse) return { status: 403, json: { ok: false, error: "Missing Manage Server permission." } };
  const managerOnly = (): FilesResult | null => (manager ? null : { status: 403, json: { ok: false, error: "Only people with Manage Server can change Server Files." } });
  const resolveQuota = input.quota ?? quotaFor;

  // ── The library ──
  if (rest.length === 0) {
    if (method === "GET") {
      const files = listServerFiles(guild.id);
      const usage = computeUsage(guild.id, files);
      const quota = await resolveQuota(guild.id);
      const used = serverFilesUsage(guild.id);
      return {
        status: 200,
        json: {
          ok: true,
          files: files.map((f) => view(f, usage.get(f.id) ?? [])),
          folders: [...new Set(files.map((f) => f.folder).filter((f): f is string => Boolean(f)))].sort((a, b) => a.localeCompare(b)),
          usage: used,
          canManage: manager,
          limits: {
            count: quota.count,
            bytes: quota.bytes,
            one: quota.one,
            free: SERVER_FILES_QUOTA.free,
            withOne: SERVER_FILES_QUOTA.one,
            fileBytes: UPLOAD_MAX_BYTES,
            maxSide: UPLOAD_MAX_SIDE,
            maxFrames: UPLOAD_MAX_FRAMES,
            perUserHour: FILE_UPLOAD_LIMITS.perUserHour,
            perGuildDay: FILE_UPLOAD_LIMITS.perGuildDay,
            text: UPLOAD_LIMITS_TEXT,
          },
        },
      };
    }
    if (method === "POST") {
      const body = await input.readJson();
      if (!body) return { status: 400, json: { ok: false, error: "Invalid JSON body" } };
      const bytes = decodeFileBase64(body.dataBase64);
      if (bytes === "too_big") return { status: 413, json: { ok: false, error: TOO_BIG } };
      if (!bytes) return { status: 400, json: { ok: false, error: "Invalid file data" } };
      const limited = takeUploadSlot(guild.id, userId);
      if (limited) return { status: 429, json: { ok: false, error: limited } };
      try {
        const saved = await saveServerFile(
          guild.id,
          userId,
          { filename: typeof body.filename === "string" ? body.filename.slice(0, 200) : "image", bytes },
          { quota: await resolveQuota(guild.id), folder: cleanFolder(body.folder) ?? null, contentCheck: input.contentCheck },
        );
        return { status: saved.existing ? 200 : 201, json: { ok: true, existing: saved.existing, file: view(saved.file) } };
      } catch (error) {
        return errorResult(error);
      }
    }
    return { status: 405, json: { error: "Method not allowed" } };
  }

  // ── Bulk ──
  if (rest.length === 1 && rest[0] === "bulk") {
    if (method !== "POST") return { status: 405, json: { error: "Method not allowed" } };
    const denied = managerOnly();
    if (denied) return denied;
    const body = await input.readJson();
    const ids = Array.isArray(body?.ids) ? body!.ids.filter((id): id is string => typeof id === "string" && FILE_ID_RE.test(id)).slice(0, 200) : [];
    if (!ids.length) return { status: 400, json: { ok: false, error: "Pick some files first." } };
    if (body?.action === "move") {
      const folder = cleanFolder(body.folder);
      if (folder === undefined) return { status: 400, json: { ok: false, error: "Invalid folder" } };
      const moved = ids.filter((id) => updateServerFile(guild.id, id, { folder })).length;
      return { status: 200, json: { ok: true, moved } };
    }
    if (body?.action === "delete") {
      const files = ids.map((id) => getServerFile(guild.id, id)).filter((f): f is ServerFile => Boolean(f));
      const usage = computeUsage(guild.id, files);
      const inUse = files.filter((f) => (usage.get(f.id) ?? []).length > 0);
      if (inUse.length && body.force !== true) {
        return {
          status: 409,
          json: {
            ok: false,
            error: `${inUse.length === 1 ? "1 file is" : `${inUse.length} files are`} still in use. Deleting breaks the image there.`,
            inUse: inUse.map((f) => ({ id: f.id, name: f.displayName, usedIn: usage.get(f.id) })),
          },
        };
      }
      const deleted = files.filter((f) => deleteServerFile(guild.id, f.id)).length;
      return { status: 200, json: { ok: true, deleted } };
    }
    return { status: 400, json: { ok: false, error: "Unknown action" } };
  }

  // ── One file ──
  const id = rest[0]!;
  if (!FILE_ID_RE.test(id)) return { status: 404, json: { error: "Not found" } };
  const file = getServerFile(guild.id, id);
  if (!file) return { status: 404, json: { ok: false, error: "That file doesn't exist anymore." } };

  if (rest.length === 1) {
    if (method === "GET") {
      const usedIn = computeUsage(guild.id, [file]).get(file.id) ?? [];
      let uploader: { id: string; name: string; avatar: string | null } | null = null;
      if (file.createdBy) {
        const { fetchMemberCached, fetchUserCached } = await import("./people.js");
        const member = await fetchMemberCached(guild, file.createdBy).catch(() => null);
        const user = member?.user ?? (await fetchUserCached(guild.client, file.createdBy).catch(() => null));
        uploader = {
          id: file.createdBy,
          name: member?.displayName ?? user?.globalName ?? user?.username ?? file.createdBy,
          avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
        };
      }
      return { status: 200, json: { ok: true, file: { ...view(file, usedIn), uploader } } };
    }
    if (method === "PATCH") {
      const denied = managerOnly();
      if (denied) return denied;
      const body = (await input.readJson()) ?? {};
      const patch: { displayName?: string; folder?: string | null } = {};
      if (body.displayName !== undefined) {
        const name = cleanDisplayName(body.displayName);
        if (!name) return { status: 400, json: { ok: false, error: "Give the file a name." } };
        patch.displayName = name;
      }
      if (body.folder !== undefined) {
        const folder = cleanFolder(body.folder);
        if (folder === undefined) return { status: 400, json: { ok: false, error: "Invalid folder" } };
        patch.folder = folder;
      }
      const updated = updateServerFile(guild.id, id, patch)!;
      return { status: 200, json: { ok: true, file: view(updated) } };
    }
    if (method === "DELETE") {
      const denied = managerOnly();
      if (denied) return denied;
      const usedIn = computeUsage(guild.id, [file]).get(file.id) ?? [];
      if (usedIn.length && query.get("force") !== "1") {
        return {
          status: 409,
          json: { ok: false, error: `Still used in ${usedIn.map((u) => u.label).join(", ")}. Deleting it breaks the image there.`, usedIn },
        };
      }
      deleteServerFile(guild.id, id);
      return { status: 200, json: { ok: true, usedIn } };
    }
    return { status: 405, json: { error: "Method not allowed" } };
  }

  if (rest.length === 2 && rest[1] === "touch") {
    if (method !== "POST") return { status: 405, json: { error: "Method not allowed" } };
    touchServerFile(guild.id, id);
    return { status: 200, json: { ok: true } };
  }

  if (rest.length === 2 && rest[1] === "replace") {
    if (method !== "POST") return { status: 405, json: { error: "Method not allowed" } };
    const denied = managerOnly();
    if (denied) return denied;
    const body = await input.readJson();
    const bytes = decodeFileBase64(body?.dataBase64);
    if (bytes === "too_big") return { status: 413, json: { ok: false, error: TOO_BIG } };
    if (!bytes) return { status: 400, json: { ok: false, error: "Invalid file data" } };
    const limited = takeUploadSlot(guild.id, userId);
    if (limited) return { status: 429, json: { ok: false, error: limited } };
    try {
      const updated = await replaceServerFile(guild.id, id, userId, bytes, { quota: await resolveQuota(guild.id), contentCheck: input.contentCheck });
      return { status: 200, json: { ok: true, file: view(updated) } };
    } catch (error) {
      return errorResult(error);
    }
  }

  return { status: 404, json: { error: "Not found" } };
}
