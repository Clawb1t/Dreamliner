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
  const { listActiveOneGuildIds } = await import("./dreamlinerOne.js");
  const oneGuildIds = await listActiveOneGuildIds();
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
        oneActive: oneGuildIds.has(guild.id),
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
          const { listPlatformDreamlinerOne } = await import("./dreamlinerOne.js");
          sendJson(res, 200, await listPlatformDreamlinerOne(client));
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
            const { listOneDiscountCodes } = await import("./oneDiscounts.js");
            sendJson(res, 200, { discounts: await listOneDiscountCodes() });
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
              const { createOneDiscountCode } = await import("./oneDiscounts.js");
              const discount = await createOneDiscountCode({
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
          const { revokeOneDiscountCode } = await import("./oneDiscounts.js");
          const discount = await revokeOneDiscountCode(decodeURIComponent(discountCodeMatch[1]!));
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
            const { redeemOneDiscountCode } = await import("./oneDiscounts.js");
            const result = await redeemOneDiscountCode({
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
            const { parseExpiresAt, upsertDreamlinerOne } = await import("./dreamlinerOne.js");
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
            const one = await upsertDreamlinerOne({
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
            const { revokeDreamlinerOne } = await import("./dreamlinerOne.js");
            const one = await revokeDreamlinerOne(guildId, userId);
            if (!one) {
              sendJson(res, 404, { error: "No Dreamliner One subscription for that server." });
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
          const { getDreamlinerOnePublicStatus } = await import("./dreamlinerOne.js");
          sendJson(res, 200, await getDreamlinerOnePublicStatus(guildId));
          return;
        }

        const profileMatch = /^\/bridge\/users\/(\d+)\/profile$/.exec(url.pathname);
        const userStatsMatch = /^\/bridge\/users\/(\d+)\/stats$/.exec(url.pathname);
        const deleteDataMatch = /^\/bridge\/users\/(\d+)\/data$/.exec(url.pathname);
        const ttsVoiceMatch = /^\/bridge\/users\/(\d+)\/tts\/voice$/.exec(url.pathname);
        const ttsPreviewMatch = /^\/bridge\/users\/(\d+)\/tts\/preview$/.exec(url.pathname);
        const stockBalanceMatch = /^\/bridge\/users\/(\d+)\/economy\/balance$/.exec(url.pathname);
        const stockPortfolioMatch = /^\/bridge\/users\/(\d+)\/stocks$/.exec(url.pathname);
        const stockBuyMatch = /^\/bridge\/users\/(\d+)\/stocks\/(\d+)\/buy$/.exec(url.pathname);
        const stockSellMatch = /^\/bridge\/users\/(\d+)\/stocks\/(\d+)\/sell$/.exec(url.pathname);

        if (stockBalanceMatch && req.method === "GET") {
          const { getUserGlobalBalance } = await import("./webStocks.js");
          const result = getUserGlobalBalance(stockBalanceMatch[1]!);
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 200, { ok: true, balance: result.balance });
          return;
        }

        if (stockPortfolioMatch && req.method === "GET") {
          const { getUserPortfolio } = await import("./webStocks.js");
          const result = getUserPortfolio(stockPortfolioMatch[1]!);
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 200, result);
          return;
        }

        if (stockBuyMatch && req.method === "POST") {
          let body: { amount?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { buyStockForUser } = await import("./webStocks.js");
          const result = buyStockForUser(stockBuyMatch[1]!, stockBuyMatch[2]!, Number(body.amount));
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 200, result);
          return;
        }

        if (stockSellMatch && req.method === "POST") {
          let body: { shares?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { sellStockForUser } = await import("./webStocks.js");
          const result = sellStockForUser(stockSellMatch[1]!, stockSellMatch[2]!, Number(body.shares));
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 200, result);
          return;
        }

        if (req.method === "GET" && url.pathname === "/bridge/tts/voices") {
          const { listTtsVoicesForWeb } = await import("./webTts.js");
          sendJson(res, 200, { ok: true, voices: await listTtsVoicesForWeb() });
          return;
        }

        if (ttsVoiceMatch && req.method === "GET") {
          const { getTtsVoiceForWeb } = await import("./webTts.js");
          sendJson(res, 200, { ok: true, ...(await getTtsVoiceForWeb(ttsVoiceMatch[1]!)) });
          return;
        }

        if (ttsVoiceMatch && req.method === "PUT") {
          let body: { voice?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof body.voice !== "string" || !body.voice.trim()) {
            sendJson(res, 400, { error: "voice is required." });
            return;
          }
          const { setTtsVoiceForWeb } = await import("./webTts.js");
          const result = await setTtsVoiceForWeb(ttsVoiceMatch[1]!, body.voice.trim());
          if (!result.ok) {
            sendJson(res, 400, { error: result.error });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (ttsPreviewMatch && req.method === "POST") {
          let body: { voice?: unknown } = {};
          try {
            const raw = await readBody(req);
            if (raw.trim()) body = JSON.parse(raw) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const { synthesizeTtsPreviewForWeb } = await import("./webTts.js");
          const result = await synthesizeTtsPreviewForWeb(
            client,
            ttsPreviewMatch[1]!,
            typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : undefined,
          );
          if ("error" in result) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendBinary(res, 200, result.wav, "audio/wav");
          return;
        }

        if (profileMatch && req.method === "GET") {
          const userId = profileMatch[1]!;
          const { getUserProfile } = await import("./userProfiles.js");
          sendJson(res, 200, { ok: true, profile: await getUserProfile(userId) });
          return;
        }

        if (profileMatch && req.method === "PUT") {
          let body: {
            accentColor?: unknown;
            bio?: unknown;
            profileVisible?: unknown;
            showNavBalance?: unknown;
            showNavExchange?: unknown;
            showTradingCards?: unknown;
            contentRetentionDays?: unknown;
          };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const {
            getUserProfile,
            normalizeAccentColor,
            normalizeBio,
            upsertUserProfileFields,
          } = await import("./userProfiles.js");
          const { normalizeContentRetentionDays } = await import("../core/contentRetention.js");

          const patch: {
            accentColor?: string | null;
            bio?: string | null;
            profileVisible?: boolean;
            showNavBalance?: boolean;
            showNavExchange?: boolean;
            showTradingCards?: boolean;
            contentRetentionDays?: number;
          } = {};

          if ("accentColor" in body) {
            const accent = normalizeAccentColor(body.accentColor);
            if (accent === undefined) {
              sendJson(res, 400, { error: "accentColor must be a #RRGGBB hex color or null." });
              return;
            }
            patch.accentColor = accent;
          }
          if ("bio" in body) {
            const bio = normalizeBio(body.bio);
            if (bio === undefined && body.bio !== undefined) {
              sendJson(res, 400, { error: "bio must be a string or null." });
              return;
            }
            patch.bio = bio ?? null;
          }
          if ("profileVisible" in body) {
            if (typeof body.profileVisible !== "boolean") {
              sendJson(res, 400, { error: "profileVisible must be a boolean." });
              return;
            }
            patch.profileVisible = body.profileVisible;
          }
          if ("showNavBalance" in body) {
            if (typeof body.showNavBalance !== "boolean") {
              sendJson(res, 400, { error: "showNavBalance must be a boolean." });
              return;
            }
            patch.showNavBalance = body.showNavBalance;
          }
          if ("showNavExchange" in body) {
            if (typeof body.showNavExchange !== "boolean") {
              sendJson(res, 400, { error: "showNavExchange must be a boolean." });
              return;
            }
            patch.showNavExchange = body.showNavExchange;
          }
          if ("showTradingCards" in body) {
            if (typeof body.showTradingCards !== "boolean") {
              sendJson(res, 400, { error: "showTradingCards must be a boolean." });
              return;
            }
            patch.showTradingCards = body.showTradingCards;
          }
          if ("contentRetentionDays" in body) {
            try {
              const days = normalizeContentRetentionDays(body.contentRetentionDays);
              if (days === undefined) {
                sendJson(res, 400, { error: "contentRetentionDays is required." });
                return;
              }
              patch.contentRetentionDays = days;
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Invalid contentRetentionDays.",
              });
              return;
            }
          }

          if (Object.keys(patch).length === 0) {
            sendJson(res, 200, { ok: true, profile: await getUserProfile(profileMatch[1]!) });
            return;
          }
          const profile = await upsertUserProfileFields(profileMatch[1]!, patch);
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

        // --- Public profile / badges ---------------------------------------------------

        // Profiles are never cached bridge-side — always fresh. The website fetches these
        // in parallel (identity first/fast, the rest streamed in as each resolves) rather
        // than blocking the whole page on one combined response.
        const publicProfileMatch = /^\/bridge\/users\/(\d+)\/public-profile$/.exec(url.pathname);
        if (publicProfileMatch && req.method === "GET") {
          const { buildPublicUserProfile } = await import("./userPublicProfile.js");
          const profile = await buildPublicUserProfile(client, publicProfileMatch[1]!);
          if (!profile) {
            sendJson(res, 404, { error: "User not found." });
            return;
          }
          sendJson(res, 200, { ok: true, profile });
          return;
        }

        const publicProfileIdentityMatch = /^\/bridge\/users\/(\d+)\/public-profile\/identity$/.exec(
          url.pathname,
        );
        if (publicProfileIdentityMatch && req.method === "GET") {
          const { buildPublicProfileIdentity } = await import("./userPublicProfile.js");
          const identity = await buildPublicProfileIdentity(client, publicProfileIdentityMatch[1]!);
          if (!identity) {
            sendJson(res, 404, { error: "User not found." });
            return;
          }
          sendJson(res, 200, { ok: true, identity });
          return;
        }

        const publicProfileStatsMatch = /^\/bridge\/users\/(\d+)\/public-profile\/stats$/.exec(
          url.pathname,
        );
        if (publicProfileStatsMatch && req.method === "GET") {
          const { buildPublicProfileStats } = await import("./userPublicProfile.js");
          const stats = await buildPublicProfileStats(publicProfileStatsMatch[1]!);
          sendJson(res, 200, { ok: true, stats });
          return;
        }

        const publicProfileActivityMatch = /^\/bridge\/users\/(\d+)\/public-profile\/activity$/.exec(
          url.pathname,
        );
        if (publicProfileActivityMatch && req.method === "GET") {
          const { buildPublicProfileActivity } = await import("./userPublicProfile.js");
          const daily = await buildPublicProfileActivity(publicProfileActivityMatch[1]!);
          sendJson(res, 200, { ok: true, daily });
          return;
        }

        const publicProfileHoursMatch = /^\/bridge\/users\/(\d+)\/public-profile\/hours$/.exec(
          url.pathname,
        );
        if (publicProfileHoursMatch && req.method === "GET") {
          const { buildPublicProfileHours } = await import("./userPublicProfile.js");
          const activeHoursUtc = await buildPublicProfileHours(publicProfileHoursMatch[1]!);
          sendJson(res, 200, { ok: true, activeHoursUtc });
          return;
        }

        const publicProfileServersMatch = /^\/bridge\/users\/(\d+)\/public-profile\/servers$/.exec(
          url.pathname,
        );
        if (publicProfileServersMatch && req.method === "GET") {
          const { buildPublicProfileServers } = await import("./userPublicProfile.js");
          const guilds = await buildPublicProfileServers(client, publicProfileServersMatch[1]!);
          sendJson(res, 200, { ok: true, guilds });
          return;
        }

        const publicProfileCardsMatch = /^\/bridge\/users\/(\d+)\/public-profile\/cards$/.exec(
          url.pathname,
        );
        if (publicProfileCardsMatch && req.method === "GET") {
          const { buildPublicProfileCards } = await import("./userPublicProfile.js");
          const cards = await buildPublicProfileCards(publicProfileCardsMatch[1]!);
          sendJson(res, 200, { ok: true, ...cards });
          return;
        }

        // Public card catalog (not per-user) — used for marketing pages, e.g. the homepage's
        // decorative card stack, which just wants a handful of real card images to show off.
        const planeCardCatalogMatch = url.pathname === "/bridge/plane-cards/catalog";
        if (planeCardCatalogMatch && req.method === "GET") {
          const { listPublicPlaneCardCatalog } = await import("./planeCards.js");
          const limitRaw = Number(url.searchParams.get("limit"));
          const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : undefined;
          const cards = listPublicPlaneCardCatalog({ limit });
          sendJson(res, 200, { ok: true, cards });
          return;
        }

        // Plane/airline trading card art. Not per-guild, not per-user — the same public art
        // file (assets/planes/<imageKey>) backs every card of that type across the whole bot.
        const planeCardImageMatch = /^\/bridge\/plane-cards\/image\/([^/]+)$/.exec(url.pathname);
        if (planeCardImageMatch && req.method === "GET") {
          const { isValidImageKey, planeImagePath } = await import(
            "../plugins/planes/functions/images.js"
          );
          const imageKey = decodeURIComponent(planeCardImageMatch[1]!);
          if (!isValidImageKey(imageKey)) {
            sendJson(res, 400, { error: "Invalid image key." });
            return;
          }
          const path = planeImagePath(imageKey)!;
          let buf: Buffer;
          try {
            buf = await (await import("node:fs/promises")).readFile(path);
          } catch {
            sendJson(res, 404, { error: "Image not found." });
            return;
          }
          const ext = imageKey.slice(imageKey.lastIndexOf(".") + 1).toLowerCase();
          const contentType =
            ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
          sendBinary(res, 200, buf, contentType);
          return;
        }

        // --- Plane/airline card catalog admin (platform superusers only) -------------------

        if (url.pathname === "/bridge/platform/plane-cards/images") {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const requesterId = url.searchParams.get("userId")?.trim();
          if (!requesterId || !isDashboardSuperuser(requesterId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const { listPlaneCardImageFiles } = await import("./planeCards.js");
          sendJson(res, 200, { ok: true, files: listPlaneCardImageFiles() });
          return;
        }

        if (url.pathname === "/bridge/platform/plane-cards/settings") {
          if (req.method === "GET") {
            const requesterId = url.searchParams.get("userId")?.trim();
            if (!requesterId || !isDashboardSuperuser(requesterId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { getPlaneCardPackSettings } = await import("./planeCards.js");
            sendJson(res, 200, { ok: true, settings: getPlaneCardPackSettings() });
            return;
          }
          if (req.method === "PUT") {
            let body: { userId?: string; packPrice?: unknown; packSize?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const actorId = body.userId?.trim();
            if (!actorId || !isDashboardSuperuser(actorId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { updatePlaneCardPackSettings } = await import("./planeCards.js");
            try {
              const patch: { packPrice?: number; packSize?: number } = {};
              if (body.packPrice !== undefined) {
                const price = Number(body.packPrice);
                if (!Number.isFinite(price) || price < 0) {
                  sendJson(res, 400, { error: "packPrice must be a non-negative number." });
                  return;
                }
                patch.packPrice = price;
              }
              if (body.packSize !== undefined) {
                const size = Math.round(Number(body.packSize));
                if (!Number.isFinite(size) || size < 1 || size > 5) {
                  sendJson(res, 400, { error: "packSize must be between 1 and 5." });
                  return;
                }
                patch.packSize = size;
              }
              const settings = updatePlaneCardPackSettings(patch, actorId);
              sendJson(res, 200, { ok: true, settings });
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Failed to update pack settings.",
              });
            }
            return;
          }
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (url.pathname === "/bridge/platform/plane-cards") {
          if (req.method === "GET") {
            const requesterId = url.searchParams.get("userId")?.trim();
            if (!requesterId || !isDashboardSuperuser(requesterId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { listAdminPlaneCards } = await import("./planeCards.js");
            sendJson(res, 200, { ok: true, cards: listAdminPlaneCards() });
            return;
          }
          if (req.method === "POST") {
            let body: Record<string, unknown> & { userId?: string };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const actorId = body.userId?.trim();
            if (!actorId || !isDashboardSuperuser(actorId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { createAdminPlaneCard } = await import("./planeCards.js");
            try {
              const card = createAdminPlaneCard({
                key: body.key,
                name: body.name,
                cardType: body.cardType,
                subtitle: body.subtitle,
                rarity: body.rarity,
                imageKey: body.imageKey,
                safety: body.safety,
                speed: body.speed,
                agility: body.agility,
                passengerCount: body.passengerCount,
                reputation: body.reputation,
                fleetSize: body.fleetSize,
                destinations: body.destinations,
                createdBy: actorId,
              });
              sendJson(res, 200, { ok: true, card });
            } catch (error) {
              sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to create card." });
            }
            return;
          }
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        const platformPlaneCardMatch = /^\/bridge\/platform\/plane-cards\/(\d+)$/.exec(url.pathname);
        if (platformPlaneCardMatch && (req.method === "PUT" || req.method === "DELETE")) {
          let body: Record<string, unknown> & { userId?: string };
          try {
            body = JSON.parse((await readBody(req)) || "{}") as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const actorId = body.userId?.trim();
          if (!actorId || !isDashboardSuperuser(actorId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const cardId = Number(platformPlaneCardMatch[1]);

          if (req.method === "DELETE") {
            const { disableAdminPlaneCard } = await import("./planeCards.js");
            try {
              const card = disableAdminPlaneCard(cardId);
              sendJson(res, 200, { ok: true, card });
            } catch (error) {
              sendJson(res, 404, { error: error instanceof Error ? error.message : "Card not found." });
            }
            return;
          }

          const { updateAdminPlaneCard } = await import("./planeCards.js");
          try {
            const card = updateAdminPlaneCard(cardId, {
              name: body.name,
              subtitle: body.subtitle,
              rarity: body.rarity,
              imageKey: body.imageKey,
              enabled: body.enabled,
              speed: body.speed,
              agility: body.agility,
              passengerCount: body.passengerCount,
              reputation: body.reputation,
              fleetSize: body.fleetSize,
              destinations: body.destinations,
              safety: body.safety,
            });
            sendJson(res, 200, { ok: true, card });
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to update card." });
          }
          return;
        }

        const userLookupMatch = /^\/bridge\/users\/(\d+)\/lookup$/.exec(url.pathname);
        if (userLookupMatch && req.method === "GET") {
          const requesterId = url.searchParams.get("userId")?.trim();
          if (!requesterId || !isDashboardSuperuser(requesterId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const { lookupDiscordUser } = await import("./userPublicProfile.js");
          const user = await lookupDiscordUser(client, userLookupMatch[1]!);
          if (!user) {
            sendJson(res, 404, { error: "Discord user not found." });
            return;
          }
          sendJson(res, 200, { ok: true, user });
          return;
        }

        const ownedBadgesMatch = /^\/bridge\/users\/(\d+)\/badges$/.exec(url.pathname);
        if (ownedBadgesMatch && req.method === "GET") {
          const { listUserBadges } = await import("./userBadges.js");
          sendJson(res, 200, { ok: true, badges: await listUserBadges(ownedBadgesMatch[1]!) });
          return;
        }
        if (ownedBadgesMatch && req.method === "POST") {
          let body: { badgeId?: unknown; userId?: string };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const actorId = body.userId?.trim();
          if (!actorId || !isDashboardSuperuser(actorId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const badgeId = Number(body.badgeId);
          if (!Number.isInteger(badgeId)) {
            sendJson(res, 400, { error: "badgeId must be an integer." });
            return;
          }
          const { assignBadge } = await import("./userBadges.js");
          const badges = await assignBadge(ownedBadgesMatch[1]!, badgeId, actorId);
          sendJson(res, 200, { ok: true, badges });
          return;
        }

        const userBadgeMatch = /^\/bridge\/users\/(\d+)\/badges\/(\d+)$/.exec(url.pathname);
        if (userBadgeMatch && req.method === "DELETE") {
          let body: { userId?: string };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const actorId = body.userId?.trim();
          if (!actorId || !isDashboardSuperuser(actorId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const { unassignBadge } = await import("./userBadges.js");
          const badges = await unassignBadge(userBadgeMatch[1]!, Number(userBadgeMatch[2]));
          sendJson(res, 200, { ok: true, badges });
          return;
        }

        const badgeDisplayMatch = /^\/bridge\/users\/(\d+)\/badges\/display$/.exec(url.pathname);
        if (badgeDisplayMatch && req.method === "PUT") {
          let body: { badgeIds?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (!Array.isArray(body.badgeIds) || body.badgeIds.some((id) => typeof id !== "number")) {
            sendJson(res, 400, { error: "badgeIds must be an array of numbers." });
            return;
          }
          const { setDisplayedBadges } = await import("./userBadges.js");
          const badges = await setDisplayedBadges(badgeDisplayMatch[1]!, body.badgeIds as number[]);
          sendJson(res, 200, { ok: true, badges });
          return;
        }

        if (url.pathname === "/bridge/platform/badges") {
          if (req.method === "GET") {
            const requesterId = url.searchParams.get("userId")?.trim();
            if (!requesterId || !isDashboardSuperuser(requesterId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { listBadges } = await import("./badges.js");
            sendJson(res, 200, { ok: true, badges: await listBadges() });
            return;
          }
          if (req.method === "POST") {
            let body: {
              userId?: string;
              key?: unknown;
              name?: unknown;
              description?: unknown;
              icon?: unknown;
              iconImage?: unknown;
              colorHex?: unknown;
            };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const actorId = body.userId?.trim();
            if (!actorId || !isDashboardSuperuser(actorId)) {
              sendJson(res, 403, { error: "Platform access required." });
              return;
            }
            const { normalizeBadgeKey, normalizeBadgeColor, normalizeBadgeIconImage, createBadge } =
              await import("./badges.js");
            const key = normalizeBadgeKey(body.key);
            if (!key) {
              sendJson(res, 400, {
                error: "key must be lowercase letters/numbers/dashes/underscores, 2-64 chars.",
              });
              return;
            }
            const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
            if (!name) {
              sendJson(res, 400, { error: "name is required." });
              return;
            }
            const colorHex = normalizeBadgeColor(body.colorHex);
            if (colorHex === undefined) {
              sendJson(res, 400, { error: "colorHex must be a #RRGGBB hex color or null." });
              return;
            }
            let iconImage: string | null;
            try {
              iconImage = normalizeBadgeIconImage(body.iconImage) ?? null;
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Invalid icon image.",
              });
              return;
            }
            try {
              const badge = await createBadge({
                key,
                name,
                description:
                  typeof body.description === "string" ? body.description.trim().slice(0, 200) : null,
                icon: typeof body.icon === "string" ? body.icon.trim().slice(0, 16) : "",
                iconImage,
                colorHex,
              });
              sendJson(res, 200, { ok: true, badge });
            } catch (error) {
              sendJson(res, 400, {
                error: error instanceof Error ? error.message : "Failed to create badge.",
              });
            }
            return;
          }
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        const platformBadgeMatch = /^\/bridge\/platform\/badges\/(\d+)$/.exec(url.pathname);
        if (platformBadgeMatch && (req.method === "PUT" || req.method === "DELETE")) {
          let body: {
            userId?: string;
            name?: unknown;
            description?: unknown;
            icon?: unknown;
            iconImage?: unknown;
            colorHex?: unknown;
          };
          try {
            body = JSON.parse(await readBody(req) || "{}") as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const actorId = body.userId?.trim();
          if (!actorId || !isDashboardSuperuser(actorId)) {
            sendJson(res, 403, { error: "Platform access required." });
            return;
          }
          const badgeId = Number(platformBadgeMatch[1]);

          if (req.method === "DELETE") {
            const { deleteBadge } = await import("./badges.js");
            const ok = await deleteBadge(badgeId);
            if (!ok) {
              sendJson(res, 404, { error: "Badge not found." });
              return;
            }
            sendJson(res, 200, { ok: true });
            return;
          }

          const { normalizeBadgeColor, normalizeBadgeIconImage, updateBadge } = await import(
            "./badges.js"
          );
          const colorHex = normalizeBadgeColor(body.colorHex);
          if ("colorHex" in body && colorHex === undefined) {
            sendJson(res, 400, { error: "colorHex must be a #RRGGBB hex color or null." });
            return;
          }
          let iconImage: string | null | undefined;
          try {
            iconImage = "iconImage" in body ? normalizeBadgeIconImage(body.iconImage) : undefined;
          } catch (error) {
            sendJson(res, 400, {
              error: error instanceof Error ? error.message : "Invalid icon image.",
            });
            return;
          }
          try {
            const badge = await updateBadge(badgeId, {
              name: typeof body.name === "string" ? body.name.trim().slice(0, 60) : undefined,
              description:
                typeof body.description === "string"
                  ? body.description.trim().slice(0, 200)
                  : body.description === null
                    ? null
                    : undefined,
              icon: typeof body.icon === "string" ? body.icon.trim().slice(0, 16) : undefined,
              iconImage,
              colorHex: "colorHex" in body ? colorHex : undefined,
            });
            if (!badge) {
              sendJson(res, 404, { error: "Badge not found." });
              return;
            }
            sendJson(res, 200, { ok: true, badge });
          } catch (error) {
            sendJson(res, 400, {
              error: error instanceof Error ? error.message : "Failed to update badge.",
            });
          }
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
          const { cached } = await import("./responseCache.js");
          const query = parseWebStatsQuery(url);
          const payload = await cached(`stats:global:${JSON.stringify(query)}`, 30_000, () =>
            buildWebGlobalStats(client, query),
          );
          sendJson(res, 200, payload);
          return;
        }

        if (req.method === "GET" && url.pathname === "/bridge/stats/global/public-leaderboard") {
          const { buildWebGlobalPublicMessagerLeaderboard } = await import("./webStats.js");
          const { cached } = await import("./responseCache.js");
          const limit = Number(url.searchParams.get("limit") ?? 25) || 25;
          const payload = await cached(`leaderboard:global:${limit}`, 30_000, () =>
            buildWebGlobalPublicMessagerLeaderboard(client, limit),
          );
          sendJson(res, 200, payload);
          return;
        }

        // Dreamliner Exchange (public — every server with economy enabled is listed).
        if (req.method === "GET" && url.pathname === "/bridge/stocks") {
          const { getExchangeOverview } = await import("./webStocks.js");
          sendJson(res, 200, await getExchangeOverview(url.searchParams.get("range")));
          return;
        }

        const stockDetailMatch = /^\/bridge\/stocks\/(\d+)$/.exec(url.pathname);
        if (stockDetailMatch && req.method === "GET") {
          const { getStockDetail } = await import("./webStocks.js");
          const result = await getStockDetail(stockDetailMatch[1]!, url.searchParams.get("range"));
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          const { ok: _ok, ...payload } = result;
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
        const socialResolveMatch = /^\/bridge\/guilds\/(\d+)\/social\/resolve$/.exec(url.pathname);
        const socialWatcherTestMatch = /^\/bridge\/guilds\/(\d+)\/social\/watchers\/(\d+)\/test$/.exec(
          url.pathname,
        );
        const socialWatcherOneMatch = /^\/bridge\/guilds\/(\d+)\/social\/watchers\/(\d+)$/.exec(url.pathname);
        const socialWatchersMatch = /^\/bridge\/guilds\/(\d+)\/social\/watchers$/.exec(url.pathname);
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
        const watchdogMatch = /^\/bridge\/guilds\/(\d+)\/watchdog$/.exec(url.pathname);
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
        const ticketActionMatch =
          /^\/bridge\/guilds\/(\d+)\/tickets\/(\d+)\/(close|claim|unclaim|reopen|add|remove|rename)$/.exec(
            url.pathname,
          );
        const ticketPanelPublishMatch = /^\/bridge\/guilds\/(\d+)\/tickets\/panels\/([0-9a-fA-F-]{36})\/publish$/.exec(
          url.pathname,
        );
        const ticketBlacklistMatch = /^\/bridge\/guilds\/(\d+)\/tickets\/blacklist(?:\/([^/]+))?$/.exec(
          url.pathname,
        );
        const ticketStatsMatch = /^\/bridge\/guilds\/(\d+)\/tickets\/stats$/.exec(url.pathname);
        const ticketOneMatch = /^\/bridge\/guilds\/(\d+)\/tickets\/(\d+)$/.exec(url.pathname);
        const ticketsMatch = /^\/bridge\/guilds\/(\d+)\/tickets$/.exec(url.pathname);
        const scamProtectMatch = /^\/bridge\/guilds\/(\d+)\/scam-protect(?:\/(setup|disable))?$/.exec(
          url.pathname,
        );
        const ttsBlacklistMatch = /^\/bridge\/guilds\/(\d+)\/tts\/blacklist(?:\/([^/]+))?$/.exec(
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
        const nameHistoryMatch = /^\/bridge\/guilds\/(\d+)\/name-history$/.exec(url.pathname);
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
          !socialResolveMatch &&
          !socialWatcherTestMatch &&
          !socialWatcherOneMatch &&
          !socialWatchersMatch &&
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
          !watchdogMatch &&
          !reviewOneMatch &&
          !reviewsMatch &&
          !suggestionActionMatch &&
          !suggestionOneMatch &&
          !suggestionStatsMatch &&
          !suggestionsMatch &&
          !ticketActionMatch &&
          !ticketPanelPublishMatch &&
          !ticketBlacklistMatch &&
          !ticketStatsMatch &&
          !ticketOneMatch &&
          !ticketsMatch &&
          !scamProtectMatch &&
          !ttsBlacklistMatch &&
          !welcomeAssetMatch &&
          !welcomePreviewMatch &&
          !welcomeTestMatch &&
          !rolePanelsPreviewMatch &&
          !rolePanelsTestMatch &&
          !rolePanelsValidateMatch &&
          !passportMatch &&
          !nameHistoryMatch &&
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
          socialResolveMatch?.[1] ??
          socialWatcherTestMatch?.[1] ??
          socialWatcherOneMatch?.[1] ??
          socialWatchersMatch?.[1] ??
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
          watchdogMatch?.[1] ??
          reviewOneMatch?.[1] ??
          reviewsMatch?.[1] ??
          suggestionActionMatch?.[1] ??
          suggestionOneMatch?.[1] ??
          suggestionStatsMatch?.[1] ??
          suggestionsMatch?.[1] ??
          ticketActionMatch?.[1] ??
          ticketPanelPublishMatch?.[1] ??
          ticketBlacklistMatch?.[1] ??
          ticketStatsMatch?.[1] ??
          ticketOneMatch?.[1] ??
          ticketsMatch?.[1] ??
          scamProtectMatch?.[1] ??
          ttsBlacklistMatch?.[1] ??
          welcomeAssetMatch?.[1] ??
          welcomePreviewMatch?.[1] ??
          welcomeTestMatch?.[1] ??
          rolePanelsPreviewMatch?.[1] ??
          rolePanelsTestMatch?.[1] ??
          rolePanelsValidateMatch?.[1] ??
          passportMatch?.[1] ??
          nameHistoryMatch?.[1] ??
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

          // GET /economy — overview (global currency info + this server's settings)
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

          // POST /economy/settings — update this server's currency name/symbol/rates
          if (segments[0] === "settings" && segments.length === 1 && req.method === "POST") {
            const body = await readJsonBody<Record<string, unknown> & { userId?: string }>();
            if (!body) return;
            const actorId = await requireManage(body.userId);
            if (!actorId) return;
            const { userId: _u, ...patch } = body;
            const result = await econ.updateEconomySettings(configManager, guildId, actorId, patch);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, actorId, {
              eventType: "dashboard_economy",
              title: "Economy settings updated",
              summary: "Updated the server economy settings from the dashboard.",
              payload: { server: result.server },
            });
            sendJson(res, 200, { ok: true, server: result.server });
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
            // Global balance only — server admins can no longer adjust a member's server-currency
            // balance; it now only moves through normal play and /exchange. See webEconomy.ts.
            if (segments.length === 3 && segments[2] === "adjust" && req.method === "POST") {
              const body = await readJsonBody<{
                userId?: string;
                mode?: "add" | "take" | "set";
                amount?: number;
              }>();
              if (!body) return;
              const actorId = await requireManage(body.userId);
              if (!actorId) return;
              const result = await econ.adjustEconomyAccount(configManager, guildId, targetUserId, {
                mode: body.mode ?? "add",
                amount: Number(body.amount ?? 0),
              });
              if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
              }
              trackDashboardAction(client, guildId, actorId, {
                eventType: "dashboard_economy",
                title: "Economy balance adjust",
                summary: `Adjusted the global balance for <@${targetUserId}>.`,
                targetId: targetUserId,
                payload: { balance: result.balance, mode: body.mode ?? "add" },
              });
              sendJson(res, 200, { ok: true, balance: result.balance });
              return;
            }
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (nameHistoryMatch) {
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

          const { getWebUserNameHistory, searchWebNameHistory, parseWebNameHistoryLimit } =
            await import("./webNameHistory.js");
          const limit = parseWebNameHistoryLimit(url);
          const target = url.searchParams.get("target")?.trim();
          const q = url.searchParams.get("q");

          if (target) {
            const result = await getWebUserNameHistory(guild, target, limit);
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              ...result,
            });
            return;
          }

          const result = await searchWebNameHistory(guild, q ?? "", limit);
          sendJson(res, 200, {
            guild: { id: guild.id, name: guild.name, icon: guild.icon },
            ...result,
          });
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
            let body: { userId?: string; channelName?: string };
            try {
              body = JSON.parse(await readBody(req)) as { userId?: string; channelName?: string };
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
            const result = await setupWebScamProtect(guild, configManager, userId, body.channelName);
            if (!result.ok) {
              sendJson(res, 400, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_scam_protect",
              title: "Scam protect enabled",
              summary: "Scam protect was set up from the dashboard.",
              details: body.channelName?.trim()
                ? [`Channel name: \`${body.channelName.trim()}\``]
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

        if (ttsBlacklistMatch) {
          const userId = url.searchParams.get("userId")?.trim();
          if (!userId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, userId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }

          const { listGuildTtsBlacklist, addGuildTtsBlacklist, removeGuildTtsBlacklist } = await import("./webTts.js");

          if (req.method === "GET") {
            sendJson(res, 200, { ok: true, blacklist: await listGuildTtsBlacklist(guild) });
            return;
          }

          if (req.method === "POST") {
            let body: { targetId?: string; reason?: string } = {};
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            if (!body.targetId) {
              sendJson(res, 400, { error: "targetId is required" });
              return;
            }
            const blacklist = await addGuildTtsBlacklist(guild, body.targetId, body.reason);
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_tts",
              title: "TTS blacklist updated",
              summary: `\`${body.targetId}\` was blocked from using TTS from the dashboard.`,
              targetId: body.targetId,
              payload: { action: "blacklist_add", targetId: body.targetId },
            });
            sendJson(res, 200, { ok: true, blacklist });
            return;
          }

          if (req.method === "DELETE") {
            const targetId = ttsBlacklistMatch[2];
            if (!targetId) {
              sendJson(res, 400, { error: "targetId is required" });
              return;
            }
            const blacklist = await removeGuildTtsBlacklist(guild, targetId);
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_tts",
              title: "TTS blacklist updated",
              summary: `\`${targetId}\` was unblocked from using TTS from the dashboard.`,
              targetId,
              payload: { action: "blacklist_remove", targetId },
            });
            sendJson(res, 200, { ok: true, blacklist });
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
          const { cached } = await import("./responseCache.js");
          const limit = Number(url.searchParams.get("limit") ?? 25) || 25;
          const payload = await cached(`leaderboard:guild:${guild.id}:${limit}`, 30_000, () =>
            buildWebPublicMessagerLeaderboard(guild, limit),
          );
          sendJson(res, 200, payload);
          return;
        }

        if (publicGuildMatch) {
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const { buildPublicGuildHome } = await import("./publicGuild.js");
          const { cached } = await import("./responseCache.js");
          const payload = await cached(`public-guild-home:${guild.id}`, 30_000, () =>
            buildPublicGuildHome(guild),
          );
          sendJson(res, 200, payload);
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
          const { cached } = await import("./responseCache.js");
          const query = parseWebStatsQuery(url);
          const payload = await cached(
            `public-guild-stats:${guild.id}:${JSON.stringify(query)}`,
            30_000,
            () => buildWebPublicServerStats(guild, query),
          );
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

        if (watchdogMatch) {
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
          const { buildWebWatchdogList } = await import("./webWatchdog.js");
          const payload = await buildWebWatchdogList(guild);
          sendJson(res, 200, { ok: true, ...payload });
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

        if (ticketsMatch || ticketOneMatch || ticketStatsMatch || ticketActionMatch || ticketPanelPublishMatch || ticketBlacklistMatch) {
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
            parseWebTicketsQuery,
            listGuildTickets,
            getGuildTicket,
            getGuildTicketStats,
            performTicketAction,
            deleteGuildTicket,
            webRenameTicket,
            publishTicketPanel,
            listGuildTicketBlacklist,
            addGuildTicketBlacklist,
            removeGuildTicketBlacklist,
          } = await import("./webTickets.js");

          if (ticketStatsMatch) {
            if (req.method !== "GET") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            const stats = await getGuildTicketStats(guild);
            sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, stats });
            return;
          }

          if (ticketBlacklistMatch) {
            if (req.method === "GET") {
              sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, blacklist: await listGuildTicketBlacklist(guild) });
              return;
            }
            if (req.method === "POST") {
              let body: { targetId?: string; targetType?: "user" | "role"; reason?: string } = {};
              try {
                body = JSON.parse(await readBody(req)) as typeof body;
              } catch {
                sendJson(res, 400, { error: "Invalid JSON body" });
                return;
              }
              if (!body.targetId) {
                sendJson(res, 400, { error: "targetId is required" });
                return;
              }
              const blacklist = await addGuildTicketBlacklist(guild, body.targetId, body.targetType ?? "user", body.reason);
              trackDashboardAction(client, guildId, userId, {
                eventType: "dashboard_ticket",
                title: "Ticket blacklist updated",
                summary: `\`${body.targetId}\` was blocked from opening tickets from the dashboard.`,
                targetId: body.targetId,
                payload: { action: "blacklist_add", targetId: body.targetId },
              });
              sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, blacklist });
              return;
            }
            if (req.method === "DELETE") {
              const targetId = ticketBlacklistMatch[2];
              if (!targetId) {
                sendJson(res, 400, { error: "targetId is required" });
                return;
              }
              const blacklist = await removeGuildTicketBlacklist(guild, targetId);
              trackDashboardAction(client, guildId, userId, {
                eventType: "dashboard_ticket",
                title: "Ticket blacklist updated",
                summary: `\`${targetId}\` was unblocked from opening tickets from the dashboard.`,
                targetId,
                payload: { action: "blacklist_remove", targetId },
              });
              sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, blacklist });
              return;
            }
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }

          if (ticketPanelPublishMatch) {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            const panelId = ticketPanelPublishMatch[2]!;
            const result = await publishTicketPanel(guild, panelId, userId);
            if ("error" in result) {
              sendJson(res, 400, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_ticket",
              title: "Ticket panel published",
              summary: `Panel \`${panelId}\` was posted from the dashboard.`,
              targetId: panelId,
              payload: { action: "panel_publish", panelId, messageId: result.messageId },
            });
            sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, ...result });
            return;
          }

          if (ticketActionMatch) {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            let body: { reason?: string; userId?: string; name?: string } = {};
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const ticketId = Number(ticketActionMatch[2]);
            const action = ticketActionMatch[3]!;

            if (action === "rename") {
              if (!body.name?.trim()) {
                sendJson(res, 400, { error: "name is required" });
                return;
              }
              const result = await webRenameTicket(guild, ticketId, body.name.trim());
              if ("error" in result) {
                sendJson(res, 400, { error: result.error });
                return;
              }
              sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, ok: true });
              return;
            }

            const result = await performTicketAction(
              guild,
              ticketId,
              action as "close" | "claim" | "unclaim" | "reopen" | "add" | "remove",
              userId,
              body,
            );
            if ("error" in result) {
              sendJson(res, 400, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_ticket",
              title: `Ticket ${action}`,
              summary: `Ticket \`#${ticketId}\` was ${action}ed from the dashboard.`,
              targetId: String(ticketId),
              payload: { ticketId, action },
            });
            sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, ticket: result.ticket });
            return;
          }

          if (ticketsMatch) {
            if (req.method !== "GET") {
              sendJson(res, 405, { error: "Method not allowed" });
              return;
            }
            const query = parseWebTicketsQuery(url);
            const result = await listGuildTickets(guild, query);
            sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, ...result });
            return;
          }

          const ticketId = Number(ticketOneMatch![2]);
          if (!Number.isFinite(ticketId) || ticketId <= 0) {
            sendJson(res, 400, { error: "Invalid ticket id" });
            return;
          }

          if (req.method === "DELETE") {
            const result = await deleteGuildTicket(guild, ticketId);
            if ("error" in result) {
              sendJson(res, 400, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_ticket",
              title: "Ticket deleted",
              summary: `Ticket \`#${ticketId}\` was deleted from the dashboard.`,
              targetId: String(ticketId),
              payload: { ticketId, action: "delete" },
            });
            sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, deleted: true, id: ticketId });
            return;
          }

          if (req.method !== "GET") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const detail = await getGuildTicket(guild, ticketId);
          if (!detail) {
            sendJson(res, 404, { error: "Ticket not found" });
            return;
          }
          sendJson(res, 200, { guild: { id: guild.id, name: guild.name, icon: guild.icon }, ticket: detail });
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
              count: result.count,
              maxCommands: result.maxCommands,
            });
            return;
          }

          if (commandsMatch && req.method === "POST") {
            let body: { userId?: string; name?: string; program?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const requesterId = body.userId?.trim();
            if (!requesterId || typeof body.name !== "string" || typeof body.program !== "object" || body.program === null) {
              sendJson(res, 400, { error: "userId, name, and program are required" });
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
              program: body.program,
            });
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, requesterId, {
              eventType: "dashboard_command",
              title: "Custom command created",
              summary: `Custom command \`/${result.command.name}\` was created from the dashboard.`,
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
            let body: { userId?: string; program?: unknown };
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const requesterId = body.userId?.trim();
            if (!requesterId || typeof body.program !== "object" || body.program === null) {
              sendJson(res, 400, { error: "userId and program are required" });
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
              { program: body.program },
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, requesterId, {
              eventType: "dashboard_command",
              title: "Custom command updated",
              summary: `Custom command \`/${result.command.name}\` was updated from the dashboard.`,
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
              title: "Custom command deleted",
              summary: `Custom command \`/${result.command.name}\` was deleted from the dashboard.`,
              targetId: result.command.name,
              payload: { name: result.command.name },
            });
            sendJson(res, 200, { ok: true, command: result.command });
            return;
          }

          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        if (socialResolveMatch && req.method === "POST") {
          let body: { userId?: string; input?: string };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const requesterId = body.userId?.trim();
          if (!requesterId || typeof body.input !== "string" || !body.input.trim()) {
            sendJson(res, 400, { error: "userId and input are required" });
            return;
          }
          if (!(await memberCanManage(guild, requesterId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const { resolveBridgeSocialSource } = await import("./social.js");
          const result = await resolveBridgeSocialSource(configManager, guildId, body.input);
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 200, { channel: result.channel });
          return;
        }

        if (socialWatcherTestMatch) {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          let body: { userId?: string };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const requesterId = body.userId?.trim();
          if (!requesterId) {
            sendJson(res, 400, { error: "userId is required" });
            return;
          }
          if (!(await memberCanManage(guild, requesterId))) {
            sendJson(res, 403, { error: "Missing Manage Server permission." });
            return;
          }
          const { testSendBridgeSocialWatcher } = await import("./social.js");
          const result = await testSendBridgeSocialWatcher(
            client,
            configManager,
            guildId,
            Number(socialWatcherTestMatch[2]),
          );
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 200, { ok: true, sent: result.sent });
          return;
        }

        if (socialWatchersMatch || socialWatcherOneMatch) {
          const userId =
            req.method === "GET" || req.method === "DELETE"
              ? url.searchParams.get("userId")?.trim()
              : undefined;

          if (socialWatchersMatch && req.method === "GET") {
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { listBridgeSocialWatchers } = await import("./social.js");
            const result = await listBridgeSocialWatchers(configManager, guildId);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            sendJson(res, 200, {
              guild: { id: guild.id, name: guild.name, icon: guild.icon },
              watchers: result.watchers,
              count: result.count,
              maxWatchers: result.maxWatchers,
            });
            return;
          }

          if (socialWatchersMatch && req.method === "POST") {
            let body: { userId?: string } & Record<string, unknown>;
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const requesterId = body.userId?.trim();
            if (!requesterId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, requesterId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { createBridgeSocialWatcher } = await import("./social.js");
            const result = await createBridgeSocialWatcher(configManager, guildId, requesterId, body);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, requesterId, {
              eventType: "dashboard_command",
              title: "Social notification created",
              summary: `A YouTube notification for **${result.watcher.sourceChannelName}** was created from the dashboard.`,
              targetId: String(result.watcher.id),
              payload: { sourceChannelName: result.watcher.sourceChannelName },
            });
            sendJson(res, 200, { ok: true, watcher: result.watcher });
            return;
          }

          if (socialWatcherOneMatch && req.method === "PATCH") {
            let body: { userId?: string } & Record<string, unknown>;
            try {
              body = JSON.parse(await readBody(req)) as typeof body;
            } catch {
              sendJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
            const requesterId = body.userId?.trim();
            if (!requesterId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, requesterId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { updateBridgeSocialWatcher } = await import("./social.js");
            const result = await updateBridgeSocialWatcher(
              configManager,
              guildId,
              Number(socialWatcherOneMatch[2]),
              body,
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, requesterId, {
              eventType: "dashboard_command",
              title: "Social notification updated",
              summary: `A YouTube notification for **${result.watcher.sourceChannelName}** was updated from the dashboard.`,
              targetId: String(result.watcher.id),
              payload: { sourceChannelName: result.watcher.sourceChannelName },
            });
            sendJson(res, 200, { ok: true, watcher: result.watcher });
            return;
          }

          if (socialWatcherOneMatch && req.method === "DELETE") {
            if (!userId) {
              sendJson(res, 400, { error: "userId is required" });
              return;
            }
            if (!(await memberCanManage(guild, userId))) {
              sendJson(res, 403, { error: "Missing Manage Server permission." });
              return;
            }
            const { deleteBridgeSocialWatcher } = await import("./social.js");
            const result = await deleteBridgeSocialWatcher(
              configManager,
              guildId,
              Number(socialWatcherOneMatch[2]),
            );
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error });
              return;
            }
            trackDashboardAction(client, guildId, userId, {
              eventType: "dashboard_command",
              title: "Social notification deleted",
              summary: `A YouTube notification for **${result.watcher.sourceChannelName}** was deleted from the dashboard.`,
              targetId: String(result.watcher.id),
              payload: { sourceChannelName: result.watcher.sourceChannelName },
            });
            sendJson(res, 200, { ok: true, watcher: result.watcher });
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
          const { cached } = await import("./responseCache.js");
          const query = parseWebStatsQuery(url);
          const payload = await cached(
            `stats:guild:${guild.id}:${JSON.stringify(query)}`,
            30_000,
            () => buildWebServerStats(guild, query),
          );
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
