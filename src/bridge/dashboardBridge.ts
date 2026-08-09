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

  return { channels, roles, members };
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

        if (!authorized(req, secret)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        if (req.method === "GET" && url.pathname === "/bridge/status") {
          sendJson(res, 200, await buildStatus(client));
          return;
        }

        const publicLeaderboardMatch =
          /^\/bridge\/guilds\/(\d+)\/stats\/public-leaderboard$/.exec(url.pathname);
        const entityStatsMatch = /^\/bridge\/guilds\/(\d+)\/stats\/(users|channels)\/(\d+)$/.exec(
          url.pathname,
        );
        const commandOneMatch = /^\/bridge\/guilds\/(\d+)\/commands\/([a-z0-9_]{1,32})$/i.exec(
          url.pathname,
        );
        const commandsMatch = /^\/bridge\/guilds\/(\d+)\/commands$/.exec(url.pathname);
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
        const logOneMatch = /^\/bridge\/guilds\/(\d+)\/logs\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
        const logsMatch = /^\/bridge\/guilds\/(\d+)\/logs$/.exec(url.pathname);
        const guildMatch = /^\/bridge\/guilds\/(\d+)\/(config|entities|stats)$/.exec(
          url.pathname,
        );
        if (
          !publicLeaderboardMatch &&
          !entityStatsMatch &&
          !commandOneMatch &&
          !commandsMatch &&
          !dbRowMatch &&
          !dbTableMatch &&
          !dbTablesMatch &&
          !modCaseMatch &&
          !modCasesMatch &&
          !logStatsMatch &&
          !logOneMatch &&
          !logsMatch &&
          !guildMatch
        ) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        const guildId = (
          publicLeaderboardMatch?.[1] ??
          entityStatsMatch?.[1] ??
          commandOneMatch?.[1] ??
          commandsMatch?.[1] ??
          dbRowMatch?.[1] ??
          dbTableMatch?.[1] ??
          dbTablesMatch?.[1] ??
          modCaseMatch?.[1] ??
          modCasesMatch?.[1] ??
          logStatsMatch?.[1] ??
          logOneMatch?.[1] ??
          logsMatch?.[1] ??
          guildMatch?.[1]
        )!;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          sendJson(res, 404, { error: "Guild not found (bot is not in that server)." });
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
          const result = await configManager.saveGuildConfig(guildId, yaml, userId);
          if (!result.success) {
            sendJson(res, 400, { error: "Validation failed", errors: result.errors });
            return;
          }
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
