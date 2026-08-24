import http from "node:http";
import type { Client, Guild } from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { ConfigManager } from "../config/manager.js";
import {
  getDashboardBridgePort,
  getDashboardBridgeSecret,
  getDreamlinerEnv,
  isDashboardBridgeEnabled,
} from "./env.js";
import { isDashboardSuperuser } from "./superuser.js";
import { trackDashboardAction } from "./dashboardAudit.js";

export type BridgeGuildSnapshot = {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  ownerId: string;
  ownerName: string | null;
  ownerDisplayName: string | null;
  ownerAvatar: string | null;
  memberCount: number;
  oneActive: boolean;
};

export type BridgeStatusPayload = {
  online: true;
  botId: string;
  startedAt: string;
  guildCount: number;
  guilds: BridgeGuildSnapshot[];
  env: string;
  checkedAt: string;
};

let startedAt: string | null = null;
let server: http.Server | null = null;

async function guildSnapshot(client: Client): Promise<BridgeGuildSnapshot[]> {
  const guilds = [...client.guilds.cache.values()];
  const { listActiveAeroGuildIds } = await import("./dreamlinerAero.js");
  const aeroGuildIds = await listActiveAeroGuildIds();
  return Promise.all(
    guilds.map(async (guild) => {
      let ownerName: string | null = null;
      let ownerDisplayName: string | null = null;
      let ownerAvatar: string | null = null;
      try {
        const owner =
          guild.members.cache.get(guild.ownerId) ??
          (await guild.fetchOwner({ cache: true }).catch(() => null));
        if (owner) {
          ownerName = owner.user.username;
          ownerDisplayName = owner.displayName;
          ownerAvatar = owner.user.displayAvatarURL({ size: 64 });
        }
      } catch {
        // Owner may be unavailable; still return the guild.
      }
      return {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner,
        ownerId: guild.ownerId,
        ownerName,
        ownerDisplayName,
        ownerAvatar,
        memberCount: guild.memberCount,
        oneActive: aeroGuildIds.has(guild.id),
      };
    }),
  );
}

async function buildStatus(client: Client): Promise<BridgeStatusPayload> {
  if (!startedAt) startedAt = new Date().toISOString();
  return {
    online: true,
    botId: client.user?.id ?? "unknown",
    startedAt,
    guildCount: client.guilds.cache.size,
    guilds: await guildSnapshot(client),
    env: getDreamlinerEnv(),
    checkedAt: new Date().toISOString(),
  };
}

function authorized(req: http.IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && match[1] === secret);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendBinary(
  res: http.ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "private, max-age=3600",
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function memberCanManage(guild: Guild, userId: string): Promise<boolean> {
  // Platform superusers (OAuth discordId, after Bearer secret) may manage any bot guild.
  if (isDashboardSuperuser(userId)) return true;

  if (guild.ownerId === userId) return true;
  try {
    const member = await guild.members.fetch(userId);
    return (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageGuild)
    );
  } catch {
    return false;
  }
}

function channelKind(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return "text";
    case ChannelType.GuildVoice:
    case ChannelType.GuildStageVoice:
      return "voice";
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.GuildForum:
    case ChannelType.GuildMedia:
      return "forum";
    default:
      return "other";
  }
}

async function buildEntities(guild: Guild) {
  if (guild.members.cache.size < 100) {
    await guild.members.fetch().catch(() => null);
  }
  await guild.emojis.fetch().catch(() => null);

  const channels = [...guild.channels.cache.values()]
    .filter((ch) => !ch.isThread())
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: channelKind(ch.type),
      parentId: "parentId" in ch ? (ch.parentId ?? null) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      position: role.position,
    }))
    .sort((a, b) => b.position - a.position);

  const members = [...guild.members.cache.values()]
    .filter((m) => !m.user.bot)
    .slice(0, 750)
    .map((m) => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName,
      avatar: m.user.displayAvatarURL({ size: 64 }),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const emojis = [...guild.emojis.cache.values()]
    .map((emoji) => ({
      id: emoji.id,
      name: emoji.name ?? "emoji",
      animated: Boolean(emoji.animated),
      url: emoji.imageURL({ size: 64 }) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { channels, roles, members, emojis };
}

/**
 * Start a small HTTP API on the bot that the website calls directly.
 */
export function startDashboardBridge(client: Client, configManager: ConfigManager): void {
  if (!isDashboardBridgeEnabled()) {
    console.log(
      "[bridge] Dashboard bridge disabled (set DASHBOARD_BRIDGE_SECRET, or DASHBOARD_ENABLED=false to silence).",
    );
    return;
  }

  const secret = getDashboardBridgeSecret()!;
  const port = getDashboardBridgePort();

  if (server) return;

  server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

        if (req.method === "GET" && url.pathname === "/health") {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Public status page (no Bearer). Used by the website /status surface.
        if (req.method === "GET" && url.pathname === "/bridge/public/status") {
          const { buildPublicBotStatus } = await import("../core/statusMonitor.js");
          const rangeRaw = (url.searchParams.get("pingRange") ?? "24h").trim().toLowerCase();
          const pingRange = rangeRaw === "7d" ? "7d" : "24h";
          sendJson(res, 200, await buildPublicBotStatus(client, pingRange));
          return;
        }

        if (!authorized(req, secret)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        if (req.method === "GET" && url.pathname === "/bridge/status") {
          sendJson(res, 200, await buildStatus(client));
          return;
        }

        if (req.method === "GET" && url.pathname === "/bridge/platform/one") {
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!isDashboardSuperuser(userId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const { listPlatformDreamlinerAero } = await import("./dreamlinerAero.js");
          sendJson(res, 200, await listPlatformDreamlinerAero(client));
          return;
        }

        if (url.pathname === "/bridge/platform/one/discounts") {
          if (req.method === "GET") {
            const userId = url.searchParams.get("userId")?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!isDashboardSuperuser(userId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { listAeroDiscountCodes } = await import("./oneDiscounts.js");
            sendJson(res, 200, { discounts: await listAeroDiscountCodes() });
            return;
          }
          if (req.method === "POST") {
            let body: {
              userId?: string;
              code?: string;
              days?: unknown;
              maxRedemptions?: unknown;
              expiresAt?: unknown;
              label?: unknown;
            };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!isDashboardSuperuser(userId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const days =
              body.days === null || body.days === undefined
                ? null
                : typeof body.days === "number"
                  ? body.days
                  : Number(body.days);
            if (days != null && !Number.isFinite(days)) {
              sendJson(res, 400, { error: "days must be a number or null." });
              return;
            }
            const maxRedemptions =
              body.maxRedemptions === null || body.maxRedemptions === undefined
                ? null
                : typeof body.maxRedemptions === "number"
                  ? body.maxRedemptions
                  : Number(body.maxRedemptions);
            if (maxRedemptions != null && !Number.isFinite(maxRedemptions)) {
              sendJson(res, 400, { error: "maxRedemptions must be a number or null." });
              return;
            }
            let expiresAt: Date | null = null;
            if (typeof body.expiresAt === "string" && body.expiresAt.trim()) {
              expiresAt = new Date(body.expiresAt);
              if (!Number.isFinite(expiresAt.getTime())) {
                sendJson(res, 400, { error: "expiresAt must be a valid datetime." });
                return;
              }
            }
            try {
              const { createAeroDiscountCode } = await import("./oneDiscounts.js");
              const discount = await createAeroDiscountCode({
                code: typeof body.code === "string" ? body.code : "",
                actorId: userId,
                days,
                maxRedemptions,
                expiresAt,
                label: typeof body.label === "string" || body.label === null ? body.label : undefined,
              });
              sendJson(res, 200, { ok: true, discount });
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Failed to create discount.",
              });
            }
            return;
          }
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        const discountCodeMatch = /^\/bridge\/platform\/one\/discounts\/([^/]+)$/.exec(url.pathname);
        if (discountCodeMatch && req.method === "DELETE") {
          let body: { userId?: string };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const userId = body.userId?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!isDashboardSuperuser(userId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const { revokeAeroDiscountCode } = await import("./oneDiscounts.js");
          const discount = await revokeAeroDiscountCode(decodeURIComponent(discountCodeMatch[1]!));
          if (!discount) {
            sendJson(res, 404, { error: "Discount code not found." });
            return;
          }
          sendJson(res, 200, { ok: true, discount });
          return;
        }

        const discountRedeemMatch = /^\/bridge\/platform\/one\/discounts\/([^/]+)\/redeem$/.exec(
          url.pathname,
        );
        if (discountRedeemMatch && req.method === "POST") {
          let body: { userId?: string; guildId?: string };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const userId = body.userId?.trim();
          const guildId = body.guildId?.trim();
          if (!userId || !guildId) {
            sendJson(res, 400, { error: "userId and guildId are required" });
            return;
          }
          const guild = client.guilds.cache.get(guildId);
          if (!guild) {
            sendJson(res, 404, { error: "Dreamliner is not in that server." });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "You need Manage Server on that guild." });
            return;
          }
          try {
            const { redeemAeroDiscountCode } = await import("./oneDiscounts.js");
            const result = await redeemAeroDiscountCode({
              code: decodeURIComponent(discountRedeemMatch[1]!),
              guildId,
              actorId: userId,
            });
            sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            sendJson(res, 400, {
              error: error instanceof Error ? error.message : "Failed to redeem discount.",
            });
          }
          return;
        }

        const testEntitlementMatch = /^\/bridge\/platform\/one\/(\d+)\/test-entitlement$/.exec(
          url.pathname,
        );
        if (testEntitlementMatch) {
          let body: { userId?: string };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const userId = body.userId?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!isDashboardSuperuser(userId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const guildId = testEntitlementMatch[1]!;
          if (!client.guilds.cache.has(guildId)) {
            sendJson(res, 404, { error: "Dreamliner is not in that server." });
            return;
          }
          try {
            const {
              createGuildOneTestEntitlement,
              deleteGuildOneTestEntitlements,
            } = await import("./oneEntitlements.js");
            if (req.method === "POST") {
              const entitlement = await createGuildOneTestEntitlement(client, guildId);
              sendJson(res, 200, { ok: true, entitlement });
              return;
            }
            if (req.method === "DELETE") {
              const result = await deleteGuildOneTestEntitlements(client, guildId);
              sendJson(res, 200, { ok: true, ...result });
              return;
            }
          } catch (error) {
            sendJson(res, 400, {
              error: error instanceof Error ? error.message : "Discord entitlement request failed.",
            });
            return;
          }
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        const platformOneGuild = /^\/bridge\/platform\/one\/(\d+)$/.exec(url.pathname);
        if (platformOneGuild) {
          const guildId = platformOneGuild[1]!;
          if (req.method === "PUT") {
            let body: { userId?: string; expiresAt?: unknown; note?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!isDashboardSuperuser(userId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { parseExpiresAt, upsertDreamlinerAero } = await import("./dreamlinerAero.js");
            if (!("expiresAt" in body)) {
              sendJson(res, 400, { error: "expiresAt is required (ISO string or null for forever)." });
              return;
            }
            const expiresAt = parseExpiresAt(body.expiresAt);
            if (expiresAt === undefined) {
              sendJson(res, 400, { error: "expiresAt must be an ISO datetime string or null." });
              return;
            }
            const note = typeof body.note === "string" || body.note === null ? body.note : undefined;
            // Response field stays "one" — unchanged wire protocol (see rebrand plan).
            const one = await upsertDreamlinerAero({
              guildId,
              actorId: userId,
              expiresAt,
              note,
            });
            sendJson(res, 200, { ok: true, one });
            return;
          }

          if (req.method === "DELETE") {
            let body: { userId?: string };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!isDashboardSuperuser(userId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { revokeDreamlinerAero } = await import("./dreamlinerAero.js");
            const one = await revokeDreamlinerAero(guildId, userId);
            if (!one) {
              sendJson(res, 404, { error: "No Dreamliner Aero subscription for that server." });
              return;
            }
            sendJson(res, 200, { ok: true, one });
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        const guildOneMatch = /^\/bridge\/guilds\/(\d+)\/one$/.exec(url.pathname);
        if (guildOneMatch && req.method === "GET") {
          const guildId = guildOneMatch[1]!;
          const guild = client.guilds.cache.get(guildId);
          if (!guild) {
            sendJson(res, 404, { error: "Guild not found (bot is not in that server)." });
            return;
          }
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const { getDreamlinerAeroPublicStatus } = await import("./dreamlinerAero.js");
          sendJson(res, 200, await getDreamlinerAeroPublicStatus(guildId));
          return;
        }

        const profileMatch = /^\/bridge\/users\/(\d+)\/profile$/.exec(url.pathname);
        const userStatsMatch = /^\/bridge\/users\/(\d+)\/stats$/.exec(url.pathname);
        const deleteDataMatch = /^\/bridge\/users\/(\d+)\/data$/.exec(url.pathname);

        if (profileMatch && req.method === "GET") {
          const userId = profileMatch[1]!;
          const { getUserProfile } = await import("./userProfiles.js");
          sendJson(res, 200, { ok: true, profile: await getUserProfile(userId) });
          return;
        }

        if (profileMatch && req.method === "PUT") {
          let body: { accentColor?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as { accentColor?: unknown };
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const {
            getUserProfile,
            normalizeAccentColor,
            upsertUserAccent,
          } = await import("./userProfiles.js");
          if (!("accentColor" in body)) {
            sendJson(res, 200, { ok: true, profile: await getUserProfile(profileMatch[1]!) });
            return;
          }
          const accent = normalizeAccentColor(body.accentColor);
          if (accent === undefined) {
            sendJson(res, 400, { error: "accentColor must be a #RRGGBB hex color or null." });
            return;
          }
          const profile = await upsertUserAccent(profileMatch[1]!, accent);
          sendJson(res, 200, { ok: true, profile });
          return;
        }

        if (userStatsMatch && req.method === "GET") {
          const { buildUserPersonalStats } = await import("./userStats.js");
          sendJson(res, 200, {
            ok: true,
            stats: await buildUserPersonalStats(client, userStatsMatch[1]!),
          });
          return;
        }

        if (deleteDataMatch && req.method === "GET") {
          const { previewUserPersonalData } = await import("./userProfiles.js");
          sendJson(res, 200, {
            ok: true,
            inventory: await previewUserPersonalData(deleteDataMatch[1]!),
          });
          return;
        }

        if (deleteDataMatch && req.method === "DELETE") {
          const { deleteUserPersonalData } = await import("./userProfiles.js");
          const result = await deleteUserPersonalData(deleteDataMatch[1]!);
          sendJson(res, 200, result);
          return;
        }

        // Live editor schema from this bot process (keeps prod dashboard in sync).
        if (req.method === "GET" && url.pathname === "/bridge/config-editor") {
          const { buildGuildConfigEditorArtifacts } = await import(
            "../config/exportGuildConfigSchema.js"
          );
          sendJson(res, 200, buildGuildConfigEditorArtifacts());
          return;
        }

        // Public global analytics (no guild / Manage Server required).
        if (req.method === "GET" && url.pathname === "/bridge/stats/global") {
          const { parseWebStatsQuery, buildWebGlobalStats } = await import("./webStats.js");
          const query = parseWebStatsQuery(url);
          const payload = await buildWebGlobalStats(client, query);
          sendJson(res, 200, payload);
          return;
        }

        if (req.method === "GET" && url.pathname === "/bridge/stats/global/public-leaderboard") {
          const { buildWebGlobalPublicMessagerLeaderboard } = await import("./webStats.js");
          const limit = Number(url.searchParams.get("limit") ?? 25) || 25;
          const payload = await buildWebGlobalPublicMessagerLeaderboard(client, limit);
          sendJson(res, 200, payload);
          return;
        }

        const publicLeaderboardMatch =
          /^\/bridge\/guilds\/(\d+)\/stats\/public-leaderboard$/.exec(url.pathname);
        const publicGuildMatch = /^\/bridge\/guilds\/(\d+)\/public$/.exec(url.pathname);
        const publicStatsMatch = /^\/bridge\/guilds\/(\d+)\/stats\/public$/.exec(url.pathname);
        const publicStatsConfigMatch = /^\/bridge\/guilds\/(\d+)\/public-stats$/.exec(
          url.pathname,
        );
        const customChartOneMatch =
          /^\/bridge\/guilds\/(\d+)\/stats\/custom-charts\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
        const customChartsMatch = /^\/bridge\/guilds\/(\d+)\/stats\/custom-charts$/.exec(
          url.pathname,
        );
        const entityStatsMatch = /^\/bridge\/guilds\/(\d+)\/stats\/(users|channels)\/(\d+)$/.exec(
          url.pathname,
        );
        const commandOneMatch = /^\/bridge\/guilds\/(\d+)\/commands\/([a-z0-9_]{1,32})$/i.exec(
          url.pathname,
        );
        const commandsMatch = /^\/bridge\/guilds\/(\d+)\/commands$/.exec(url.pathname);
        const tagOneMatch = /^\/bridge\/guilds\/(\d+)\/tags\/([a-z0-9][a-z0-9_-]{0,63})$/i.exec(
          url.pathname,
        );
        const tagsMatch = /^\/bridge\/guilds\/(\d+)\/tags$/.exec(url.pathname);
        const dbRowMatch =
          /^\/bridge\/guilds\/(\d+)\/db\/tables\/([a-z0-9_]+)\/rows\/(.+)$/.exec(url.pathname);
        const dbTableMatch = /^\/bridge\/guilds\/(\d+)\/db\/tables\/([a-z0-9_]+)$/.exec(
          url.pathname,
        );
        const dbTablesMatch = /^\/bridge\/guilds\/(\d+)\/db\/tables$/.exec(url.pathname);
        const modCaseMatch = /^\/bridge\/guilds\/(\d+)\/moderation\/cases\/(\d+)$/.exec(
          url.pathname,
        );
        const modCasesMatch = /^\/bridge\/guilds\/(\d+)\/moderation\/cases$/.exec(url.pathname);
        const logStatsMatch = /^\/bridge\/guilds\/(\d+)\/logs\/stats$/.exec(url.pathname);
        const logTestMatch = /^\/bridge\/guilds\/(\d+)\/logs\/test$/.exec(url.pathname);
        const logOneMatch = /^\/bridge\/guilds\/(\d+)\/logs\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
        const logsMatch = /^\/bridge\/guilds\/(\d+)\/logs$/.exec(url.pathname);
        const trackerMatch = /^\/bridge\/guilds\/(\d+)\/tracker\/(\d+)$/.exec(url.pathname);
        const reviewOneMatch = /^\/bridge\/guilds\/(\d+)\/reviews\/(\d+)$/.exec(url.pathname);
        const reviewsMatch = /^\/bridge\/guilds\/(\d+)\/reviews$/.exec(url.pathname);
        const suggestionActionMatch =
          /^\/bridge\/guilds\/(\d+)\/suggestions\/(\d+)\/(approve|deny|mark)$/.exec(
            url.pathname,
          );
        const suggestionOneMatch = /^\/bridge\/guilds\/(\d+)\/suggestions\/(\d+)$/.exec(
          url.pathname,
        );
        const suggestionStatsMatch = /^\/bridge\/guilds\/(\d+)\/suggestions\/stats$/.exec(
          url.pathname,
        );
        const suggestionsMatch = /^\/bridge\/guilds\/(\d+)\/suggestions$/.exec(url.pathname);
        const scamProtectMatch = /^\/bridge\/guilds\/(\d+)\/scam-protect(?:\/(setup|disable))?$/.exec(
          url.pathname,
        );
        const welcomeAssetMatch = /^\/bridge\/guilds\/(\d+)\/welcome\/assets(?:\/([a-zA-Z0-9_-]+))?$/.exec(
          url.pathname,
        );
        const welcomePreviewMatch = /^\/bridge\/guilds\/(\d+)\/welcome\/preview$/.exec(url.pathname);
        const welcomeTestMatch = /^\/bridge\/guilds\/(\d+)\/welcome\/test$/.exec(url.pathname);
        const rolePanelsPreviewMatch = /^\/bridge\/guilds\/(\d+)\/role-panels\/preview$/.exec(url.pathname);
        const rolePanelsTestMatch = /^\/bridge\/guilds\/(\d+)\/role-panels\/test$/.exec(url.pathname);
        const rolePanelsValidateMatch = /^\/bridge\/guilds\/(\d+)\/role-panels\/validate$/.exec(url.pathname);
        const passportMatch =
          /^\/bridge\/guilds\/(\d+)\/passport(?:\/(verify|test-ping|panel|diagnostics|practice))?$/.exec(
            url.pathname,
          );
        const economyMatch = /^\/bridge\/guilds\/(\d+)\/economy(?:\/(.*))?$/.exec(url.pathname);
        const botProfileRequestImageMatch = /^\/bridge\/guilds\/(\d+)\/bot-profile\/requests\/(\d+)\/image$/.exec(
          url.pathname,
        );
        const botProfileRequestCancelMatch = /^\/bridge\/guilds\/(\d+)\/bot-profile\/requests\/(\d+)\/cancel$/.exec(
          url.pathname,
        );
        const botProfileMediaMatch = /^\/bridge\/guilds\/(\d+)\/bot-profile\/media\/(avatar|banner)$/.exec(
          url.pathname,
        );
        const botProfileActionMatch =
          /^\/bridge\/guilds\/(\d+)\/bot-profile(?:\/(avatar|banner|nickname|bio|display-name-style))?$/.exec(url.pathname);
        const automodPresetMatch = /^\/bridge\/guilds\/(\d+)\/automod\/presets\/(light|standard|strict)$/.exec(
          url.pathname,
        );
        const automodTestMatch = /^\/bridge\/guilds\/(\d+)\/automod\/test$/.exec(url.pathname);
        const automodMatch = /^\/bridge\/guilds\/(\d+)\/automod$/.exec(url.pathname);
        const guildMatch = /^\/bridge\/guilds\/(\d+)\/(config|entities|stats)$/.exec(
          url.pathname,
        );
        if (
          !publicLeaderboardMatch &&
          !publicGuildMatch &&
          !publicStatsMatch &&
          !publicStatsConfigMatch &&
          !customChartOneMatch &&
          !customChartsMatch &&
          !entityStatsMatch &&
          !commandOneMatch &&
          !commandsMatch &&
          !tagOneMatch &&
          !tagsMatch &&
          !dbRowMatch &&
          !dbTableMatch &&
          !dbTablesMatch &&
          !modCaseMatch &&
          !modCasesMatch &&
          !logStatsMatch &&
          !logTestMatch &&
          !logOneMatch &&
          !logsMatch &&
          !trackerMatch &&
          !reviewOneMatch &&
          !reviewsMatch &&
          !suggestionActionMatch &&
          !suggestionOneMatch &&
          !suggestionStatsMatch &&
          !suggestionsMatch &&
          !scamProtectMatch &&
          !welcomeAssetMatch &&
          !welcomePreviewMatch &&
          !welcomeTestMatch &&
          !rolePanelsPreviewMatch &&
          !rolePanelsTestMatch &&
          !rolePanelsValidateMatch &&
          !passportMatch &&
          !economyMatch &&
          !botProfileRequestImageMatch &&
          !botProfileRequestCancelMatch &&
          !botProfileMediaMatch &&
          !botProfileActionMatch &&
          !automodPresetMatch &&
          !automodTestMatch &&
          !automodMatch &&
          !guildMatch
        ) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        const guildId = (
          publicLeaderboardMatch?.[1] ??
          publicGuildMatch?.[1] ??
          publicStatsMatch?.[1] ??
          publicStatsConfigMatch?.[1] ??
          customChartOneMatch?.[1] ??
          customChartsMatch?.[1] ??
          entityStatsMatch?.[1] ??
          commandOneMatch?.[1] ??
          commandsMatch?.[1] ??
          tagOneMatch?.[1] ??
          tagsMatch?.[1] ??
          dbRowMatch?.[1] ??
          dbTableMatch?.[1] ??
          dbTablesMatch?.[1] ??
          modCaseMatch?.[1] ??
          modCasesMatch?.[1] ??
          logStatsMatch?.[1] ??
          logTestMatch?.[1] ??
          logOneMatch?.[1] ??
          logsMatch?.[1] ??
          trackerMatch?.[1] ??
          reviewOneMatch?.[1] ??
          reviewsMatch?.[1] ??
          suggestionActionMatch?.[1] ??
          suggestionOneMatch?.[1] ??
          suggestionStatsMatch?.[1] ??
          suggestionsMatch?.[1] ??
          scamProtectMatch?.[1] ??
          welcomeAssetMatch?.[1] ??
          welcomePreviewMatch?.[1] ??
          welcomeTestMatch?.[1] ??
          rolePanelsPreviewMatch?.[1] ??
          rolePanelsTestMatch?.[1] ??
          rolePanelsValidateMatch?.[1] ??
          passportMatch?.[1] ??
          economyMatch?.[1] ??
          botProfileRequestImageMatch?.[1] ??
          botProfileRequestCancelMatch?.[1] ??
          botProfileMediaMatch?.[1] ??
          botProfileActionMatch?.[1] ??
          automodPresetMatch?.[1] ??
          automodTestMatch?.[1] ??
          automodMatch?.[1] ??
          guildMatch?.[1]
        )!;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          sendJson(res, 404, { error: "Guild not found (bot is not in that server)." });
          return;
        }

        if (automodMatch || automodTestMatch || automodPresetMatch) {
          const {
            applyWebAutomodPreset,
            getWebAutomodState,
            saveWebAutomod,
            testWebAutomod,
          } = await import("./webAutomod.js");

          if (automodMatch && req.method === "GET") {
            const userId = url.searchParams.get("userId")?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            sendJson(res, 200, await getWebAutomodState(guildId));
            return;
          }

          if (automodMatch && req.method === "PUT") {
            let body: { userId?: string; enabled?: boolean; config?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as {
                userId?: string;
                enabled?: boolean;
                config?: unknown;
              };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            try {
              const saved = await saveWebAutomod(guildId, userId, body);
              trackDashboardAction(client, guildId, userId, {
                eventType: "dashboard_automod",
                title: "Automod updated",
                summary: "Automod settings were saved from the dashboard.",
                details: [
                  typeof body.enabled === "boolean" ? `Enabled: ${body.enabled ? "yes" : "no"}` : "",
                ],
              });
              sendJson(res, 200, saved);
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Failed to save automod",
              });
            }
            return;
          }

          if (automodTestMatch && req.method === "POST") {
            let body: { userId?: string; sample?: string };
            try {
              body = JSON.parse(await readBody(req)) as { userId?: string; sample?: string };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId || typeof body.sample !== "string") {
              sendJson(res, 400, { error: "userId and sample are required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            sendJson(res, 200, await testWebAutomod(guildId, body.sample));
            return;
          }

          if (automodPresetMatch && req.method === "POST") {
            let body: { userId?: string; enable?: boolean; preview?: boolean };
            try {
              body = JSON.parse(await readBody(req)) as {
                userId?: string;
                enable?: boolean;
                preview?: boolean;
              };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            const preset = automodPresetMatch[2] as "light" | "standard" | "strict";
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            try {
              const applied = await applyWebAutomodPreset(guildId, userId, preset, {
                enablePlugin: body.enable !== false,
                preview: body.preview === true,
              });
              if (body.preview !== true) {
                trackDashboardAction(client, guildId, userId, {
                  eventType: "dashboard_automod",
                  title: "Automod preset applied",
                  summary: `Applied automod preset \`${preset}\` from the dashboard.`,
                  payload: { preset },
                });
              }
              sendJson(res, 200, applied);
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Failed to apply preset",
              });
            }
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (botProfileRequestImageMatch || botProfileRequestCancelMatch || botProfileMediaMatch || botProfileActionMatch) {
          const {
            cancelBridgeBrandRequest,
            clearBridgeBrandImage,
            getBridgeBotBrandRequestImage,
            getBridgeBotProfile,
            getBridgeLiveBrandImage,
            setBridgeBotBio,
            setBridgeBotDisplayNameStyle,
            setBridgeBotNickname,
            submitBridgeBrandImage,
          } = await import("./webBotProfile.js");

          const requireManage = async (userId: string | null | undefined): Promise<string | null> => {
            const id = userId?.trim();
            if (!id) {
              sendJson(res, 400, { error: "userId is required" });
              return null;
            }
            if (!(await memberCanManage(guild, id))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return null;
            }
            return id;
          };

          if (botProfileActionMatch && !botProfileActionMatch[2] && req.method === "GET") {
            const userId = await requireManage(url.searchParams.get("userId"));
            if (!userId) return;
            const result = await getBridgeBotProfile(client, configManager, guild);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendJson(res, 200, result.profile);
            return;
          }

          if (botProfileMediaMatch && req.method === "GET") {
            const userId = await requireManage(url.searchParams.get("userId"));
            if (!userId) return;
            const kind = botProfileMediaMatch[2] as "avatar" | "banner";
            const result = await getBridgeLiveBrandImage(client, configManager, guild, kind);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendBinary(res, 200, result.body, result.contentType);
            return;
          }

          if (botProfileRequestImageMatch && req.method === "GET") {
            const userId = await requireManage(url.searchParams.get("userId"));
            if (!userId) return;
            const requestId = Number(botProfileRequestImageMatch[2]);
            const result = await getBridgeBotBrandRequestImage(configManager, guildId, requestId);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendBinary(res, 200, result.png, "image/png");
            return;
          }

          if (botProfileRequestCancelMatch && req.method === "POST") {
            let body: { userId?: string };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = await requireManage(body.userId);
            if (!userId) return;
            const requestId = Number(botProfileRequestCancelMatch[2]);
            const result = await cancelBridgeBrandRequest(client, configManager, guildId, requestId, userId);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_bot_brand",
              title: "Bot brand request cancelled",
              summary: `Cancelled pending ${result.request.kind} request #${result.request.id} from the dashboard.`,
              payload: { requestId: result.request.id, kind: result.request.kind },
            });
            sendJson(res, 200, { ok: true, request: result.request });
            return;
          }

          const action = botProfileActionMatch?.[2];

          if (action === "avatar" || action === "banner") {
            if (req.method === "POST") {
              let body: { userId?: string; imageBase64?: string };
              try {
                body = JSON.parse(await readBody(req)) as typeof body;
              } catch {
                sendJson(res, 400, { error: "Invalid JSON body" });
                return;
              }
              const userId = await requireManage(body.userId);
              if (!userId) return;
              if (typeof body.imageBase64 !== "string") {
                sendJson(res, 400, { error: "imageBase64 is required" });
                return;
              }
              const result = await submitBridgeBrandImage(
                client,
                configManager,
                guild,
                userId,
                action,
                body.imageBase64,
              );
              if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
              }
              trackDashboardAction(client, guildId, userId, {
                eventType: "dashboard_bot_brand",
                title: `Bot ${action} submitted`,
                summary: `Queued a ${action} change for staff approval from the dashboard.`,
                details: [
                  `Request: \`#${result.request.id}\``,
                  `Review posted: ${result.reviewPosted ? "yes" : "no"}`,
                ],
                payload: { requestId: result.request.id, kind: action },
              });
              sendJson(res, 200, {
                ok: true,
                request: result.request,
                reviewPosted: result.reviewPosted,
              });
              return;
            }

            if (req.method === "DELETE") {
              let body: { userId?: string };
              try {
                body = JSON.parse(await readBody(req)) as typeof body;
              } catch {
                sendJson(res, 400, { error: "Invalid JSON body" });
                return;
              }
              const userId = await requireManage(body.userId);
              if (!userId) return;
              const result = await clearBridgeBrandImage(configManager, guild, userId, action);
              if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
              }
              trackDashboardAction(client, guildId, userId, {
                eventType: "dashboard_bot_brand",
                title: `Bot ${action} cleared`,
                summary: `Cleared Dreamliner's server ${action} from the dashboard.`,
                payload: { kind: action },
              });
              sendJson(res, 200, { ok: true });
              return;
            }
          }

          if (action === "nickname" && req.method === "PUT") {
            let body: { userId?: string; nick?: string | null };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = await requireManage(body.userId);
            if (!userId) return;
            if (!("nick" in body)) {
              sendJson(res, 400, { error: "nick is required (string or null to clear)" });
              return;
            }
            const result = await setBridgeBotNickname(
              configManager,
              guild,
              userId,
              body.nick == null ? null : String(body.nick),
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_bot_brand",
              title: "Bot nickname updated",
              summary: result.nick
                ? `Set Dreamliner's nickname to **${result.nick}** from the dashboard.`
                : "Cleared Dreamliner's nickname from the dashboard.",
              payload: { nick: result.nick },
            });
            sendJson(res, 200, { ok: true, nick: result.nick });
            return;
          }

          if (action === "bio" && req.method === "PUT") {
            let body: { userId?: string; bio?: string | null };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = await requireManage(body.userId);
            if (!userId) return;
            if (!("bio" in body)) {
              sendJson(res, 400, { error: "bio is required (string or null to clear)" });
              return;
            }
            const result = await setBridgeBotBio(
              configManager,
              guild,
              userId,
              body.bio == null ? null : String(body.bio),
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_bot_brand",
              title: "Bot bio updated",
              summary: result.bio
                ? "Updated Dreamliner's server bio from the dashboard."
                : "Cleared Dreamliner's server bio from the dashboard.",
              payload: { bioLength: result.bio?.length ?? 0 },
            });
            sendJson(res, 200, { ok: true, bio: result.bio });
            return;
          }

          if (action === "display-name-style" && req.method === "PUT") {
            let body: {
              userId?: string;
              style?: { fontId?: unknown; effectId?: unknown; colors?: unknown } | null;
            };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = await requireManage(body.userId);
            if (!userId) return;
            if (!("style" in body)) {
              sendJson(res, 400, { error: "style is required (object or null to clear)" });
              return;
            }
            const style =
              body.style == null
                ? null
                : {
                    fontId: Number(body.style.fontId),
                    effectId: Number(body.style.effectId),
                    colors: Array.isArray(body.style.colors)
                      ? body.style.colors.map((color) => Number(color))
                      : [],
                  };
            const result = await setBridgeBotDisplayNameStyle(
              client,
              configManager,
              guild,
              userId,
              style,
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_bot_brand",
              title: "Bot display name style updated",
              summary: style
                ? "Updated Dreamliner's display name font, effect, and colors from the dashboard."
                : "Cleared Dreamliner's display name style from the dashboard.",
              payload: { displayNameStyle: result.displayNameStyle },
            });
            sendJson(res, 200, {
              ok: true,
              displayNameStyle: result.displayNameStyle,
            });
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (welcomeAssetMatch || welcomePreviewMatch || welcomeTestMatch) {
          const {
            buildWelcomePreview,
            getWelcomeBackground,
            removeWelcomeBackground,
            sendWelcomeTest,
            uploadWelcomeBackground,
          } = await import("./webWelcome.js");

          if (welcomeTestMatch && req.method === "POST") {
            let body: { userId?: string; target?: string; config?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const targetRaw = (body.target ?? "join").trim();
            if (targetRaw !== "join" && targetRaw !== "leave" && targetRaw !== "dm") {
              sendJson(res, 400, { error: "target must be join, leave, or dm" });
              return;
            }
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
              sendJson(res, 404, { error: "Could not find your member in this server." });
              return;
            }
            const result = await sendWelcomeTest(guild, member, targetRaw, body.config);
            sendJson(res, result.ok ? 200 : 400, { ok: result.ok, detail: result.detail });
            return;
          }

          if (welcomePreviewMatch && req.method === "POST") {
            let body: {
              userId?: string;
              card?: unknown;
              embed?: unknown;
              content?: string;
              sampleUserId?: string;
            };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            try {
              const preview = await buildWelcomePreview(client, guild, body);
              sendJson(res, 200, { ok: true, ...preview });
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Failed to build preview",
              });
            }
            return;
          }

          if (welcomeAssetMatch && req.method === "POST" && !welcomeAssetMatch[2]) {
            let body: { userId?: string; imageBase64?: string };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId || typeof body.imageBase64 !== "string") {
              sendJson(res, 400, { error: "userId and imageBase64 are required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            try {
              const saved = await uploadWelcomeBackground(guildId, body.imageBase64);
              trackDashboardAction(client, guildId, userId, {
                eventType: "dashboard_welcome",
                title: "Welcomer background uploaded",
                summary: "A welcomer card background was uploaded from the dashboard.",
                details: saved.assetId ? [`Asset: \`${saved.assetId}\``] : [],
                payload: { assetId: saved.assetId ?? null },
              });
              sendJson(res, 200, { ok: true, ...saved });
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Failed to upload image",
              });
            }
            return;
          }

          if (welcomeAssetMatch?.[2] && req.method === "GET") {
            const userId = url.searchParams.get("userId")?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const buf = getWelcomeBackground(guildId, welcomeAssetMatch[2]);
            if (!buf) {
              sendJson(res, 404, { error: "Asset not found" });
              return;
            }
            sendBinary(res, 200, buf, "image/png");
            return;
          }

          if (welcomeAssetMatch?.[2] && req.method === "DELETE") {
            let body: { userId?: string };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const assetId = welcomeAssetMatch[2]!;
            const removed = removeWelcomeBackground(guildId, assetId);
            if (removed) {
              trackDashboardAction(client, guildId, userId, {
                eventType: "dashboard_welcome",
                title: "Welcomer background deleted",
                summary: "A welcomer card background was deleted from the dashboard.",
                details: [`Asset: \`${assetId}\``],
                payload: { assetId },
              });
            }
            sendJson(res, removed ? 200 : 404, {
              ok: removed,
              error: removed ? undefined : "Asset not found",
            });
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (rolePanelsPreviewMatch || rolePanelsTestMatch || rolePanelsValidateMatch) {
          const { buildRolePanelPreview, sendRolePanelTest, validateRolePanelExistingMessage } = await import(
            "./webRolePanels.js"
          );

          if (rolePanelsPreviewMatch && req.method === "POST") {
            let body: { userId?: string; panel?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const preview = await buildRolePanelPreview(client, guild, { panel: body.panel });
            sendJson(res, 200, preview);
            return;
          }

          if (rolePanelsTestMatch && req.method === "POST") {
            let body: { userId?: string; channelId?: string; panel?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const channelId = body.channelId?.trim();
            if (!channelId) {
              sendJson(res, 400, { error: "channelId is required" });
              return;
            }
            const result = await sendRolePanelTest(client, guild, channelId, body.panel);
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }

          if (rolePanelsValidateMatch && req.method === "POST") {
            let body: {
              userId?: string;
              messageLink?: string;
              triggerType?: string;
              selectionMode?: string;
            };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const messageLink = body.messageLink?.trim();
            if (!messageLink) {
              sendJson(res, 400, { error: "messageLink is required" });
              return;
            }
            const triggerType = body.triggerType === "button" ? "button" : "reaction";
            const selectionMode = body.selectionMode === "single" ? "single" : "multiple";
            const result = await validateRolePanelExistingMessage(client, guild, messageLink, triggerType, selectionMode);
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (passportMatch) {
          const {
            buildPassportPagePayload,
            completeWebPassportVerification,
            postWebPassportPanel,
            resetWebPassportPractice,
            runPassportDiagnostics,
            sendWebPassportTestPing,
          } = await import("./webPassport.js");
          const sub = passportMatch[2] ?? null;

          // Public page payload for /passport/[guildId]. No Manage Server required;
          // the website server still sends the Bearer secret.
          if (!sub && req.method === "GET") {
            const viewerUserId = url.searchParams.get("userId");
            sendJson(res, 200, await buildPassportPagePayload(guild, viewerUserId));
            return;
          }

          // Member-facing verification. Trusts the website's Auth.js session +
          // captcha; here we only require that userId is a real guild member.
          if (sub === "verify" && req.method === "POST") {
            let body: { userId?: string };
            try {
              body = JSON.parse(await readBody(req)) as { userId?: string };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            const result = await completeWebPassportVerification(client, guild, userId);
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }

          // Dashboard Test step: read-only permission + wiring report.
          if (sub === "diagnostics" && req.method === "GET") {
            const userId = url.searchParams.get("userId")?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            sendJson(res, 200, await runPassportDiagnostics(guild));
            return;
          }

          // Dashboard-only actions require Manage Server.
          if ((sub === "panel" || sub === "test-ping" || sub === "practice") && req.method === "POST") {
            let body: { userId?: string };
            try {
              body = JSON.parse(await readBody(req)) as { userId?: string };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const result =
              sub === "panel"
                ? await postWebPassportPanel(guild, userId)
                : sub === "practice"
                  ? await resetWebPassportPractice(guild, userId)
                  : await sendWebPassportTestPing(guild, userId);
            if (result.ok) {
              trackDashboardAction(client, guildId, userId, {
                eventType: "dashboard_config",
                title:
                  sub === "panel"
                    ? "Passport panel posted"
                    : sub === "practice"
                      ? "Passport practice reset"
                      : "Passport test ping sent",
                summary:
                  sub === "panel"
                    ? "A Passport verify panel was posted from the dashboard."
                    : sub === "practice"
                      ? "A staff Passport practice run was reset from the dashboard."
                      : "A Passport test ping was sent from the dashboard.",
              });
            }
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (scamProtectMatch) {
          const {
            buildWebScamProtectStatus,
            disableWebScamProtect,
            setupWebScamProtect,
          } = await import("./webScamProtect.js");
          const sub = scamProtectMatch[2] ?? null;

          if (!sub && req.method === "GET") {
            const userId = url.searchParams.get("userId")?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const status = await buildWebScamProtectStatus(guild, configManager);
            sendJson(res, 200, { ok: true, status });
            return;
          }

          if (sub === "setup" && req.method === "POST") {
            let body: { userId?: string; channelPrefix?: string };
            try {
              body = JSON.parse(await readBody(req)) as { userId?: string; channelPrefix?: string };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const result = await setupWebScamProtect(guild, configManager, userId, body.channelPrefix);
            if (!result.ok) {
              sendJson(res, 400, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_scam_protect",
              title: "Scam protect enabled",
              summary: "Scam protect was set up from the dashboard.",
              details: body.channelPrefix?.trim()
                ? [`Channel prefix: \`${body.channelPrefix.trim()}\``]
                : [],
            });
            const config = await configManager.getEffectiveConfig(guildId);
            sendJson(res, 200, { ok: true, status: result.status, config });
            return;
          }

          if (sub === "disable" && req.method === "POST") {
            let body: { userId?: string };
            try {
              body = JSON.parse(await readBody(req)) as { userId?: string };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const result = await disableWebScamProtect(guild, configManager, userId);
            if (!result.ok) {
              sendJson(res, 400, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_scam_protect",
              title: "Scam protect disabled",
              summary: "Scam protect was disabled from the dashboard.",
            });
            const config = await configManager.getEffectiveConfig(guildId);
            sendJson(res, 200, { ok: true, status: result.status, config });
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (publicLeaderboardMatch) {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const { buildWebPublicMessagerLeaderboard } = await import("./webStats.js");
          const limit = Number(url.searchParams.get("limit") ?? 25) || 25;
          const payload = await buildWebPublicMessagerLeaderboard(guild, limit);
          sendJson(res, 200, payload);
          return;
        }

        if (publicGuildMatch) {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const { buildPublicGuildHome } = await import("./publicGuild.js");
          sendJson(res, 200, await buildPublicGuildHome(guild));
          return;
        }

        if (publicStatsMatch) {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const { buildWebPublicServerStats, parseWebStatsQuery } = await import(
            "./publicGuild.js"
          );
          const payload = await buildWebPublicServerStats(guild, parseWebStatsQuery(url));
          if (!payload.ok) {
            sendJson(res, 404, payload);
            return;
          }
          sendJson(res, 200, payload);
          return;
        }

        if (publicStatsConfigMatch) {
          if (req.method === "GET") {
            const userId = url.searchParams.get("userId")?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { configManager } = await import("../config/manager.js");
            const config = await configManager.getEffectiveConfig(guild.id);
            sendJson(res, 200, { ok: true, publicStats: config.public_stats });
            return;
          }

          if (req.method === "PUT") {
            let body: { userId?: unknown; publicStats?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as {
                userId?: unknown;
                publicStats?: unknown;
              };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = typeof body.userId === "string" ? body.userId.trim() : "";
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { savePublicStatsSections } = await import("./publicGuild.js");
            const result = await savePublicStatsSections(guild.id, body.publicStats, userId);
            if (!result.ok) {
              sendJson(res, 400, { error: "Validation failed", errors: result.errors });
              return;
            }
            trackDashboardAction(client, guild.id, userId, {
              eventType: "dashboard_config",
              title: "Public stats updated",
              summary: "Public stats section visibility was updated from the dashboard.",
              payload: { publicStats: result.publicStats },
            });
            sendJson(res, 200, result);
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (customChartsMatch || customChartOneMatch) {
          const {
            listCustomCharts,
            createCustomChart,
            updateCustomChart,
            deleteCustomChart,
            validateCustomChartInput,
            customChartCatalog,
          } = await import("./webCustomCharts.js");

          if (customChartsMatch && req.method === "GET") {
            const userId = url.searchParams.get("userId")?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const charts = await listCustomCharts(guild.id);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              charts,
              catalog: customChartCatalog(),
            });
            return;
          }

          if (customChartsMatch && req.method === "POST") {
            let body: { userId?: string; chart?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as { userId?: string; chart?: unknown };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const validated = validateCustomChartInput(body.chart);
            if (!validated.ok) {
              sendJson(res, 400, { error: validated.error });
              return;
            }
            const result = await createCustomChart(guild.id, userId, validated.value);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_chart",
              title: "Custom chart created",
              summary: `Created custom chart **${result.chart.title}**.`,
              details: [`Chart id: \`${result.chart.id}\``],
              targetId: result.chart.id,
              payload: { chartId: result.chart.id, title: result.chart.title },
            });
            sendJson(res, 201, { chart: result.chart });
            return;
          }

          if (customChartOneMatch && req.method === "PUT") {
            let body: { userId?: string; chart?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as { userId?: string; chart?: unknown };
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const validated = validateCustomChartInput(body.chart);
            if (!validated.ok) {
              sendJson(res, 400, { error: validated.error });
              return;
            }
            const result = await updateCustomChart(guild.id, customChartOneMatch[2]!, validated.value);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_chart",
              title: "Custom chart updated",
              summary: `Updated custom chart **${result.chart.title}**.`,
              details: [`Chart id: \`${result.chart.id}\``],
              targetId: result.chart.id,
              payload: { chartId: result.chart.id, title: result.chart.title },
            });
            sendJson(res, 200, { chart: result.chart });
            return;
          }

          if (customChartOneMatch && req.method === "DELETE") {
            const userId = url.searchParams.get("userId")?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const chartId = customChartOneMatch[2]!;
            const result = await deleteCustomChart(guild.id, chartId);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_chart",
              title: "Custom chart deleted",
              summary: "A custom chart was deleted from the dashboard.",
              details: [`Chart id: \`${chartId}\``],
              targetId: chartId,
              payload: { chartId },
            });
            sendJson(res, 200, { ok: true });
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (modCasesMatch || modCaseMatch) {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }

          const { parseWebModCasesQuery, listWebModCases, getWebModCase } =
            await import("./webModeration.js");

          if (modCasesMatch) {
            const query = parseWebModCasesQuery(url);
            const result = await listWebModCases(guild, query);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...result,
            });
            return;
          }

          const caseId = Number(modCaseMatch![2]);
          if (!Number.isFinite(caseId) || caseId <= 0) {
            sendJson(res, 400, { error: "Invalid case id" });
            return;
          }
          const detail = await getWebModCase(guild, caseId);
          if (!detail) {
            sendJson(res, 404, { error: "Case not found" });
            return;
          }
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            case: detail,
          });
          return;
        }

        if (logTestMatch) {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          let body: { userId?: string; eventTypes?: string[] };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const userId = body.userId?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }

          const { sendAllLogTests } = await import("../core/logging/testLogs.js");
          const { isLogEventType } = await import("../core/logging/events.js");
          const { configManager } = await import("../config/manager.js");

          const requested = Array.isArray(body.eventTypes)
            ? body.eventTypes.filter((t): t is import("../core/logging/events.js").LogEventType => isLogEventType(t))
            : undefined;

          const guildConfig = await configManager.getEffectiveConfig(guild.id);
          const results = await sendAllLogTests(client, guild, guildConfig, userId, requested);
          sendJson(res, 200, {
            ok: true,
            sent: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
            results,
          });
          return;
        }

        if (logsMatch || logOneMatch || logStatsMatch) {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }

          const { parseWebLogsQuery, listWebLogs, getWebLog, getWebLogStats } =
            await import("./webLogs.js");

          if (logStatsMatch) {
            const days = Number(url.searchParams.get("days") ?? 14) || 14;
            const stats = await getWebLogStats(guild, days);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...stats,
            });
            return;
          }

          if (logsMatch) {
            const query = parseWebLogsQuery(url);
            const result = await listWebLogs(guild, query);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...result,
            });
            return;
          }

          const logId = logOneMatch![2]!;
          const detail = await getWebLog(guild, logId);
          if (!detail) {
            sendJson(res, 404, { error: "Log not found" });
            return;
          }
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            log: detail,
          });
          return;
        }

        if (trackerMatch) {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const requesterId = url.searchParams.get("userId")?.trim();
          if (!requesterId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, requesterId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const targetUserId = trackerMatch[2]!;
          const { getWebUserTrail } = await import("./webTracker.js");
          const limit = Math.min(120, Math.max(20, Number(url.searchParams.get("limit") ?? 80) || 80));
          const trail = await getWebUserTrail(guild, targetUserId, limit);
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            userId: targetUserId,
            ...trail,
          });
          return;
        }

        if (reviewsMatch || reviewOneMatch) {
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }

          const { parseWebReviewsQuery, listWebReviews, getWebReview, deleteWebReview } =
            await import("./webReviews.js");

          if (reviewsMatch) {
            if (req.method !== "GET") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            const query = parseWebReviewsQuery(url);
            const result = await listWebReviews(guild, query);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...result,
            });
            return;
          }

          const reviewId = Number(reviewOneMatch![2]);
          if (!Number.isFinite(reviewId) || reviewId <= 0) {
            sendJson(res, 400, { error: "Invalid review id" });
            return;
          }

          if (req.method === "DELETE") {
            const deleted = await deleteWebReview(guild, reviewId);
            if (!deleted) {
              sendJson(res, 404, { error: "Review not found" });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_review",
              title: "Review deleted",
              summary: "A review was deleted from the dashboard.",
              details: [`Review id: \`${reviewId}\``],
              targetId: String(reviewId),
              payload: { reviewId },
            });
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              deleted: true,
              id: reviewId,
            });
            return;
          }

          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const detail = await getWebReview(guild, reviewId);
          if (!detail) {
            sendJson(res, 404, { error: "Review not found" });
            return;
          }
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            review: detail,
          });
          return;
        }

        if (suggestionsMatch || suggestionOneMatch || suggestionStatsMatch || suggestionActionMatch) {
          if (suggestionActionMatch) {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            let body: {
              userId?: string;
              reason?: string;
              silent?: boolean;
              status?: string;
            } = {};
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const userId = body.userId?.trim();
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }

            const suggestionId = Number(suggestionActionMatch[2]);
            const action = suggestionActionMatch[3]!;
            const {
              webApproveSuggestion,
              webDenySuggestion,
              webMarkSuggestion,
              getWebSuggestion,
            } = await import("./webSuggestions.js");

            let result: { suggestion: unknown; error?: string };
            if (action === "approve") {
              result = await webApproveSuggestion(guild, suggestionId, userId);
            } else if (action === "deny") {
              result = await webDenySuggestion(guild, suggestionId, userId, body.reason, body.silent);
            } else {
              const status = body.status?.trim();
              if (!status) {
                sendJson(res, 400, { error: "status is required" });
                return;
              }
              result = await webMarkSuggestion(
                guild,
                suggestionId,
                userId,
                status as import("../config/schemas/suggestions.js").SuggestionDisplayStatus,
              );
            }

            if (result.error || !result.suggestion) {
              sendJson(res, 400, { error: result.error ?? "Action failed" });
              return;
            }
            const actionLabel =
              action === "approve" ? "approved" : action === "deny" ? "denied" : "marked";
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_suggestion",
              title: `Suggestion ${actionLabel}`,
              summary: `Suggestion \`#${suggestionId}\` was ${actionLabel} from the dashboard.`,
              details: [
                action === "mark" && body.status?.trim() ? `Status: \`${body.status.trim()}\`` : "",
                action === "deny" && body.reason?.trim() ? `Reason: ${body.reason.trim()}` : "",
              ],
              targetId: String(suggestionId),
              payload: { suggestionId, action, status: body.status ?? null },
            });
            const detail = await getWebSuggestion(guild, suggestionId);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              suggestion: detail,
            });
            return;
          }

          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }

          const {
            parseWebSuggestionsQuery,
            listWebSuggestions,
            getWebSuggestion,
            getWebSuggestionStats,
            webDeleteSuggestion,
          } = await import("./webSuggestions.js");

          if (suggestionStatsMatch) {
            if (req.method !== "GET") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            const stats = await getWebSuggestionStats(guild);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...stats,
            });
            return;
          }

          if (suggestionsMatch) {
            if (req.method !== "GET") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            const query = parseWebSuggestionsQuery(url);
            const result = await listWebSuggestions(guild, query);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...result,
            });
            return;
          }

          const suggestionId = Number(suggestionOneMatch![2]);
          if (!Number.isFinite(suggestionId) || suggestionId <= 0) {
            sendJson(res, 400, { error: "Invalid suggestion id" });
            return;
          }

          if (req.method === "DELETE") {
            const result = await webDeleteSuggestion(guild, suggestionId, userId);
            if (result.error || !result.suggestion) {
              sendJson(res, 400, { error: result.error ?? "Delete failed" });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_suggestion",
              title: "Suggestion deleted",
              summary: `Suggestion \`#${suggestionId}\` was deleted from the dashboard.`,
              targetId: String(suggestionId),
              payload: { suggestionId, action: "delete" },
            });
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              deleted: true,
              id: suggestionId,
            });
            return;
          }

          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const byNumber = url.searchParams.get("byNumber") === "true";
          const detail = await getWebSuggestion(guild, suggestionId, byNumber);
          if (!detail) {
            sendJson(res, 404, { error: "Suggestion not found" });
            return;
          }
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            suggestion: detail,
          });
          return;
        }

        if (dbTablesMatch || dbTableMatch || dbRowMatch) {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }

          const {
            listGuildDbTables,
            queryGuildDbTable,
            getGuildDbRow,
          } = await import("./webDatabase.js");

          if (dbTablesMatch) {
            const result = await listGuildDbTables(guildId);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              tables: result.tables,
            });
            return;
          }

          if (dbTableMatch) {
            const result = await queryGuildDbTable(guildId, dbTableMatch[2]!, {
              q: url.searchParams.get("q") ?? undefined,
              limit: Number(url.searchParams.get("limit") ?? 50),
              offset: Number(url.searchParams.get("offset") ?? 0),
              orderBy: url.searchParams.get("orderBy") ?? undefined,
              order: url.searchParams.get("order") ?? undefined,
            });
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            const { ok: _ok, ...payload } = result;
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...payload,
            });
            return;
          }

          const result = await getGuildDbRow(guildId, dbRowMatch![2]!, dbRowMatch![3]!);
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          const { ok: _ok, ...payload } = result;
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            ...payload,
          });
          return;
        }

        if (economyMatch) {
          const rest = (economyMatch[2] ?? "").replace(/\/+$/, "");
          const segments = rest ? rest.split("/") : [];
          const econ = await import("./webEconomy.js");

          const requireManage = async (userId: string | undefined | null): Promise<string | null> => {
            const id = userId?.trim();
            if (!id) {
              sendJson(res, 400, { error: "userId is required" });
              return null;
            }
            if (!(await memberCanManage(guild, id))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return null;
            }
            return id;
          };

          const readJsonBody = async <T extends Record<string, unknown>>(): Promise<T | null> => {
            try {
              return JSON.parse(await readBody(req)) as T;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return null;
            }
          };

          // GET /economy — overview
          if (segments.length === 0 && req.method === "GET") {
            const userId = await requireManage(url.searchParams.get("userId"));
            if (!userId) return;
            const result = await econ.getEconomyOverview(configManager, guildId);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            const { ok: _ok, ...payload } = result;
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...payload,
            });
            return;
          }

          // GET /economy/analytics
          if (segments[0] === "analytics" && segments.length === 1 && req.method === "GET") {
            const userId = await requireManage(url.searchParams.get("userId"));
            if (!userId) return;
            const days = Number(url.searchParams.get("days") ?? 14) || 14;
            const result = await econ.getEconomyAnalytics(configManager, guildId, days);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendJson(res, 200, { days: result.days, stats: result.stats });
            return;
          }

          // POST /economy/actions
          if (segments[0] === "actions" && segments.length === 1 && req.method === "POST") {
            const body = await readJsonBody<{ userId?: string; action?: string }>();
            if (!body) return;
            const userId = await requireManage(body.userId);
            if (!userId) return;
            const action = typeof body.action === "string" ? body.action.trim() : "";
            const result = await econ.runEconomyAction(configManager, guildId, action);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_economy",
              title: `Economy ${result.action}`,
              summary: `Economy action \`${result.action}\` ran from the dashboard.`,
              payload: { action: result.action, result: result.result },
            });
            sendJson(res, 200, { ok: true, action: result.action, result: result.result });
            return;
          }

          // Accounts
          if (segments[0] === "accounts" && segments[1]) {
            const targetUserId = segments[1]!;
            if (segments.length === 2 && req.method === "GET") {
              const userId = await requireManage(url.searchParams.get("userId"));
              if (!userId) return;
              const result = await econ.getEconomyAccount(configManager, guildId, targetUserId);
              if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
              }
              const { ok: _ok, ...payload } = result;
              sendJson(res, 200, payload);
              return;
            }
            if (segments.length === 3 && segments[2] === "transactions" && req.method === "GET") {
              const userId = await requireManage(url.searchParams.get("userId"));
              if (!userId) return;
              const limit = Number(url.searchParams.get("limit") ?? 25) || 25;
              const result = await econ.listEconomyTransactions(
                configManager,
                guildId,
                targetUserId,
                limit,
              );
              if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
              }
              sendJson(res, 200, { transactions: result.transactions });
              return;
            }
            if (segments.length === 3 && segments[2] === "adjust" && req.method === "POST") {
              const body = await readJsonBody<{
                userId?: string;
                currencyKey?: string;
                mode?: "add" | "take" | "set";
                pocketDelta?: number;
                bankDelta?: number;
                reason?: string;
              }>();
              if (!body) return;
              const actorId = await requireManage(body.userId);
              if (!actorId) return;
              const result = await econ.adjustEconomyAccount(configManager, guildId, targetUserId, {
                actorId,
                currencyKey: body.currencyKey,
                mode: body.mode,
                pocketDelta: body.pocketDelta,
                bankDelta: body.bankDelta,
                reason: body.reason,
              });
              if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
              }
              trackDashboardAction(client, guildId, actorId, {
                eventType: "dashboard_economy",
                title: "Economy balance adjust",
                summary: `Adjusted balances for <@${targetUserId}> (${result.currencyKey}).`,
                targetId: targetUserId,
                payload: {
                  currencyKey: result.currencyKey,
                  balances: result.balances,
                  mode: body.mode ?? "add",
                },
              });
              sendJson(res, 200, {
                ok: true,
                currencyKey: result.currencyKey,
                balances: result.balances,
              });
              return;
            }
            if (segments.length === 3 && segments[2] === "freeze" && req.method === "POST") {
              const body = await readJsonBody<{
                userId?: string;
                frozen?: boolean;
                reason?: string;
              }>();
              if (!body) return;
              const actorId = await requireManage(body.userId);
              if (!actorId) return;
              if (typeof body.frozen !== "boolean") {
                sendJson(res, 400, { error: "frozen must be a boolean" });
                return;
              }
              const result = await econ.freezeEconomyAccount(configManager, guildId, targetUserId, {
                frozen: body.frozen,
                reason: body.reason,
              });
              if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
              }
              trackDashboardAction(client, guildId, actorId, {
                eventType: "dashboard_economy",
                title: body.frozen ? "Economy account frozen" : "Economy account unfrozen",
                summary: `${body.frozen ? "Froze" : "Unfroze"} economy account for <@${targetUserId}>.`,
                targetId: targetUserId,
                payload: { frozen: body.frozen },
              });
              sendJson(res, 200, { ok: true, profile: result.profile });
              return;
            }
          }

          // Catalog CRUD: /economy/{kind} and /economy/{kind}/:id
          // Also accept pets as alias for species
          if (segments[0]) {
            const kind = econ.parseCatalogKind(segments[0]!);
            if (kind) {
              if (segments.length === 1 && req.method === "GET") {
                const userId = await requireManage(url.searchParams.get("userId"));
                if (!userId) return;
                const shopIdRaw = url.searchParams.get("shopId");
                const shopId = shopIdRaw ? Number(shopIdRaw) : undefined;
                const result = await econ.listEconomyCatalog(
                  configManager,
                  guildId,
                  kind,
                  Number.isInteger(shopId) ? shopId : undefined,
                );
                if (!result.ok) {
                  sendJson(res, result.status, { error: result.error });
                  return;
                }
                sendJson(res, 200, { items: result.items });
                return;
              }

              if (segments.length === 1 && req.method === "POST") {
                const body = await readJsonBody<Record<string, unknown>>();
                if (!body) return;
                const actorId = await requireManage(
                  typeof body.userId === "string" ? body.userId : undefined,
                );
                if (!actorId) return;
                const { userId: _u, ...payload } = body;
                const result = await econ.createEconomyCatalog(
                  configManager,
                  guildId,
                  kind,
                  payload,
                );
                if (!result.ok) {
                  sendJson(res, result.status, { error: result.error });
                  return;
                }
                trackDashboardAction(client, guildId, actorId, {
                  eventType: "dashboard_economy",
                  title: `Economy ${kind} created`,
                  summary: `Created economy ${kind} from the dashboard.`,
                  payload: { kind, id: result.item.id, key: result.item.key },
                });
                sendJson(res, 200, { ok: true, item: result.item });
                return;
              }

              if (segments.length === 2) {
                const id = econ.parseId(segments[1]!);
                if (!id) {
                  sendJson(res, 400, { error: "Invalid id" });
                  return;
                }

                if (req.method === "GET") {
                  const userId = await requireManage(url.searchParams.get("userId"));
                  if (!userId) return;
                  const result = await econ.getEconomyCatalogOne(configManager, guildId, kind, id);
                  if (!result.ok) {
                    sendJson(res, result.status, { error: result.error });
                    return;
                  }
                  sendJson(res, 200, { item: result.item });
                  return;
                }

                if (req.method === "PUT") {
                  const body = await readJsonBody<Record<string, unknown>>();
                  if (!body) return;
                  const actorId = await requireManage(
                    typeof body.userId === "string" ? body.userId : undefined,
                  );
                  if (!actorId) return;
                  const { userId: _u, ...payload } = body;
                  const result = await econ.updateEconomyCatalog(
                    configManager,
                    guildId,
                    kind,
                    id,
                    payload,
                  );
                  if (!result.ok) {
                    sendJson(res, result.status, { error: result.error });
                    return;
                  }
                  trackDashboardAction(client, guildId, actorId, {
                    eventType: "dashboard_economy",
                    title: `Economy ${kind} updated`,
                    summary: `Updated economy ${kind} #${id} from the dashboard.`,
                    targetId: String(id),
                    payload: { kind, id },
                  });
                  sendJson(res, 200, { ok: true, item: result.item });
                  return;
                }

                if (req.method === "DELETE") {
                  const userId = await requireManage(url.searchParams.get("userId"));
                  if (!userId) return;
                  const result = await econ.deleteEconomyCatalog(configManager, guildId, kind, id);
                  if (!result.ok) {
                    sendJson(res, result.status, { error: result.error });
                    return;
                  }
                  trackDashboardAction(client, guildId, userId, {
                    eventType: "dashboard_economy",
                    title: `Economy ${kind} deleted`,
                    summary: `Deleted economy ${kind} #${id} from the dashboard.`,
                    targetId: String(id),
                    payload: { kind, id },
                  });
                  sendJson(res, 200, { ok: true });
                  return;
                }
              }
            }
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (tagsMatch || tagOneMatch) {
          const userId =
            req.method === "GET" || req.method === "DELETE"
              ? url.searchParams.get("userId")?.trim()
              : undefined;

          if (tagsMatch && req.method === "GET") {
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { listBridgeTags } = await import("./webTags.js");
            const result = await listBridgeTags(configManager, guildId);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              tags: result.tags,
            });
            return;
          }

          if (tagsMatch && req.method === "POST") {
            let body: { userId?: string; name?: string; content?: string };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const requesterId = body.userId?.trim();
            if (!requesterId || typeof body.name !== "string" || typeof body.content !== "string") {
              sendJson(res, 400, { error: "userId, name, and content are required" });
              return;
            }
            if (!(await memberCanManage(guild, requesterId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { createBridgeTag } = await import("./webTags.js");
            const result = await createBridgeTag(configManager, guildId, {
              userId: requesterId,
              name: body.name,
              content: body.content,
            });
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, requesterId, {
              eventType: "dashboard_tag",
              title: "Tag created",
              summary: `Tag \`${result.tag.name}\` was created from the dashboard.`,
              targetId: result.tag.name,
              payload: { name: result.tag.name },
            });
            sendJson(res, 200, { ok: true, tag: result.tag });
            return;
          }

          if (tagOneMatch && req.method === "GET") {
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { getBridgeTag } = await import("./webTags.js");
            const result = await getBridgeTag(configManager, guildId, tagOneMatch[2]!);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendJson(res, 200, { tag: result.tag });
            return;
          }

          if (tagOneMatch && req.method === "PUT") {
            let body: { userId?: string; content?: string };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const requesterId = body.userId?.trim();
            if (!requesterId || typeof body.content !== "string") {
              sendJson(res, 400, { error: "userId and content are required" });
              return;
            }
            if (!(await memberCanManage(guild, requesterId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { updateBridgeTag } = await import("./webTags.js");
            const result = await updateBridgeTag(configManager, guildId, tagOneMatch[2]!, {
              content: body.content,
            });
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, requesterId, {
              eventType: "dashboard_tag",
              title: "Tag updated",
              summary: `Tag \`${result.tag.name}\` was updated from the dashboard.`,
              targetId: result.tag.name,
              payload: { name: result.tag.name },
            });
            sendJson(res, 200, { ok: true, tag: result.tag });
            return;
          }

          if (tagOneMatch && req.method === "DELETE") {
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const tagName = tagOneMatch[2]!;
            const { deleteBridgeTag } = await import("./webTags.js");
            const result = await deleteBridgeTag(configManager, guildId, tagName);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_tag",
              title: "Tag deleted",
              summary: `Tag \`${tagName}\` was deleted from the dashboard.`,
              targetId: tagName,
              payload: { name: tagName },
            });
            sendJson(res, 200, { ok: true });
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (commandsMatch || commandOneMatch) {
          const userId =
            req.method === "GET" || req.method === "DELETE"
              ? url.searchParams.get("userId")?.trim()
              : undefined;

          if (commandsMatch && req.method === "GET") {
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const {
              listBridgeDreamCommands,
            } = await import("./dreamCommands.js");
            const result = await listBridgeDreamCommands(configManager, guildId);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              commands: result.commands,
              slashCount: result.slashCount,
              maxSlash: result.maxSlash,
            });
            return;
          }

          if (commandsMatch && req.method === "POST") {
            let body: { userId?: string; name?: string; source?: string; minLevel?: number };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const requesterId = body.userId?.trim();
            if (!requesterId || typeof body.name !== "string" || typeof body.source !== "string") {
              sendJson(res, 400, { error: "userId, name, and source are required" });
              return;
            }
            if (!(await memberCanManage(guild, requesterId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { createBridgeDreamCommand } = await import("./dreamCommands.js");
            const result = await createBridgeDreamCommand(client, configManager, guildId, {
              userId: requesterId,
              name: body.name,
              source: body.source,
              minLevel: body.minLevel,
            });
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, requesterId, {
              eventType: "dashboard_command",
              title: "Dream command created",
              summary: `Dream command \`/${result.command.name}\` was created from the dashboard.`,
              targetId: result.command.name,
              payload: { name: result.command.name },
            });
            sendJson(res, 200, { ok: true, command: result.command });
            return;
          }

          if (commandOneMatch && req.method === "GET") {
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { getBridgeDreamCommand } = await import("./dreamCommands.js");
            const result = await getBridgeDreamCommand(
              configManager,
              guildId,
              commandOneMatch[2]!,
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendJson(res, 200, { command: result.command });
            return;
          }

          if (commandOneMatch && req.method === "PUT") {
            let body: { userId?: string; source?: string; minLevel?: number };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const requesterId = body.userId?.trim();
            if (!requesterId || typeof body.source !== "string") {
              sendJson(res, 400, { error: "userId and source are required" });
              return;
            }
            if (!(await memberCanManage(guild, requesterId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { updateBridgeDreamCommand } = await import("./dreamCommands.js");
            const result = await updateBridgeDreamCommand(
              client,
              configManager,
              guildId,
              commandOneMatch[2]!,
              { source: body.source, minLevel: body.minLevel },
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, requesterId, {
              eventType: "dashboard_command",
              title: "Dream command updated",
              summary: `Dream command \`/${result.command.name}\` was updated from the dashboard.`,
              targetId: result.command.name,
              payload: { name: result.command.name },
            });
            sendJson(res, 200, { ok: true, command: result.command });
            return;
          }

          if (commandOneMatch && req.method === "DELETE") {
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { deleteBridgeDreamCommand } = await import("./dreamCommands.js");
            const result = await deleteBridgeDreamCommand(
              client,
              configManager,
              guildId,
              commandOneMatch[2]!,
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_command",
              title: "Dream command deleted",
              summary: `Dream command \`/${result.command.name}\` was deleted from the dashboard.`,
              targetId: result.command.name,
              payload: { name: result.command.name },
            });
            sendJson(res, 200, { ok: true, command: result.command });
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (entityStatsMatch && req.method === "GET") {
          const requesterId = url.searchParams.get("userId")?.trim();
          if (!requesterId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, requesterId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const kind = entityStatsMatch[2]!;
          const entityId = entityStatsMatch[3]!;
          const {
            parseWebStatsQuery,
            buildWebUserStats,
            buildWebChannelStats,
          } = await import("./webStats.js");
          const query = parseWebStatsQuery(url);
          const payload =
            kind === "users"
              ? await buildWebUserStats(guild, entityId, query)
              : await buildWebChannelStats(guild, entityId, query);
          sendJson(res, 200, payload);
          return;
        }

        const action = guildMatch![2]!;

        if (action === "stats" && req.method === "GET") {
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const { parseWebStatsQuery, buildWebServerStats } = await import("./webStats.js");
          const query = parseWebStatsQuery(url);
          const payload = await buildWebServerStats(guild, query);
          sendJson(res, 200, payload);
          return;
        }

        if (action === "entities" && req.method === "GET") {
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const entities = await buildEntities(guild);
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            ...entities,
          });
          return;
        }

        if (action === "config" && req.method === "GET") {
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const yaml = await configManager.getDownloadYaml(guildId);
          const config = (await configManager.getEffectiveConfig(guildId)) as unknown as Record<
            string,
            unknown
          >;
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            yaml,
            config,
          });
          return;
        }

        if (action === "config" && req.method === "PUT") {
          let body: { yaml?: string; userId?: string };
          try {
            body = JSON.parse(await readBody(req)) as { yaml?: string; userId?: string };
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const userId = body.userId?.trim();
          const yaml = body.yaml;
          if (!userId || typeof yaml !== "string") {
            sendJson(res, 400, { error: "yaml and userId are required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const beforeConfig = await configManager.getEffectiveConfig(guildId);
          const result = await configManager.saveGuildConfig(guildId, yaml, userId);
          if (!result.success) {
            sendJson(res, 400, { error: "Validation failed", errors: result.errors });
            return;
          }
          if (result.data.plugins.scam_protect?.enabled === true) {
            const { ensureScamProtectChannel } = await import("../plugins/scam_protect/functions/ensure.js");
            void ensureScamProtectChannel(guild).catch(() => null);
          }
          const { diffConfigValues, formatConfigChangeLines } = await import("../config/diff.js");
          const changes = diffConfigValues(beforeConfig, result.data);
          const changeLines = formatConfigChangeLines(changes);
          trackDashboardAction(client, guildId, userId, {
            eventType: "dashboard_config",
            title: "Config updated",
            summary:
              changes.length > 0
                ? `Updated ${changes.length} setting${changes.length === 1 ? "" : "s"} from the dashboard.`
                : "Server configuration was saved from the dashboard (no field changes detected).",
            changes: changeLines,
          });
          sendJson(res, 200, {
            ok: true,
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            config: result.data,
          });
          return;
        }

        sendJson(res, 405, { error: "Method not allowed" });
      } catch (error) {
        console.error("[bridge] Request error:", error);
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : "Internal bridge error",
        });
      }
    })();
  });

  server.on("error", (error) => {
    console.error(`[bridge] HTTP server error on port ${port}:`, error);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(
      `[bridge] Dashboard bridge listening on http://0.0.0.0:${port} (${getDreamlinerEnv()})`,
    );
  });
}

export function stopDashboardBridge(): void {
  if (!server) return;
  server.close();
  server = null;
}
