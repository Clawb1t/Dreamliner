import { Events, type Client } from "discord.js";
import { LavalinkManager, type Player } from "lavalink-client";
import { getLogger } from "../../../core/logger.js";
import { registerPlayerEvents } from "./events.js";
import { reclaimResumedSessions, resumeSessionsOnBoot } from "./sessionPersistence.js";
import { loadPersistedLavalinkSessionId, savePersistedLavalinkSessionId } from "./lavalinkSession.js";

/** How long Lavalink keeps a session's players (and their live voice connections) alive after
 *  our WebSocket drops, waiting for us to reconnect and claim it back via the same session id -
 *  generous enough to cover a slow redeploy, not so long it leaves orphaned connections around
 *  if the bot is actually being taken down for a while. */
const SESSION_RESUME_TIMEOUT_MS = 300_000;

const log = getLogger("music");

let manager: LavalinkManager | undefined;

export function getLavalinkManager(): LavalinkManager {
  if (!manager) throw new Error("Lavalink manager accessed before initLavalinkManager() ran.");
  return manager;
}

export function isLavalinkConfigured(): boolean {
  return Boolean(process.env.LAVALINK_HOST?.trim() && process.env.LAVALINK_PASSWORD?.trim());
}

/** Called from the music plugin's onLoad — builds the manager and wires the raw-gateway plumbing
 *  lavalink-client needs (it does not use @discordjs/voice, see voiceSessionRegistry.ts's doc
 *  comment). Actually connecting to the node happens later, once the client is ready and has a
 *  user id (see registerReadyHandler below) — onLoad runs before client.login(). */
export function initLavalinkManager(client: Client): LavalinkManager {
  if (manager) return manager;

  if (!isLavalinkConfigured()) {
    log.warn("LAVALINK_HOST/LAVALINK_PASSWORD not set - music plugin will stay idle until configured.");
  }

  // A resumed WS connection needs the SAME session id we had before to hand our players back -
  // without this, every reconnect (including a plain bot restart) looks like a brand new client
  // to Lavalink, no matter what updateSession() does. See lavalinkSession.ts.
  const persistedSessionId = loadPersistedLavalinkSessionId();

  manager = new LavalinkManager({
    nodes: [
      {
        id: "main",
        host: process.env.LAVALINK_HOST?.trim() || "127.0.0.1",
        port: Number(process.env.LAVALINK_PORT) || 2333,
        authorization: process.env.LAVALINK_PASSWORD?.trim() || "",
        secure: process.env.LAVALINK_SECURE?.trim().toLowerCase() === "true",
        sessionId: persistedSessionId,
      },
    ],
    sendToShard: (guildId, payload) => {
      client.guilds.cache.get(guildId)?.shard?.send(payload);
    },
    client: { id: client.user?.id ?? "", username: client.user?.username ?? "Dreamliner" },
    autoSkip: true,
    playerOptions: {
      // Resolved via LavaSrc's ytdlp source + the bgutil-ytdlp-pot-provider container on the
      // Lavalink node, which generates anonymous PO tokens to clear YouTube's datacenter-IP
      // bot-wall - verified working end to end (no account/login involved). SoundCloud remains
      // available as a fallback if a specific search comes up empty.
      defaultSearchPlatform: "ytsearch",
      onDisconnect: { autoReconnect: true, destroyPlayer: false },
      // Default grace period before leaving an empty queue - matches auto_leave_empty_seconds'
      // own default (120s) philosophy but longer, since someone queueing up a next track shouldn't
      // race a fast auto-leave. Guilds with stay_connected_247 on never hit this at all (see
      // player.ts's create-time override).
      onEmptyQueue: { destroyAfterMs: 600_000 },
    },
  });

  client.on("raw", (data) => {
    void manager?.sendRawData(data);
  });

  // Resolved the first time the node connects, so boot (below) knows when it's actually safe to
  // start touching players instead of racing ahead of a WebSocket that isn't open yet.
  let nodeConnectedResolve: (() => void) | undefined;
  const nodeConnected = new Promise<void>((resolve) => {
    nodeConnectedResolve = resolve;
  });

  // Resolved once a "resumed" session handshake has been fully processed (including the players
  // it fetched) - or never, if this connection wasn't a resume. Boot waits on this too, bounded
  // by a short timeout, so reclaimResumedSessions gets a chance to run before the DB-based
  // fallback decides what still needs a full reconnect.
  let resumedSignalResolve: (() => void) | undefined;
  const resumedSignal = new Promise<void>((resolve) => {
    resumedSignalResolve = resolve;
  });

  manager.nodeManager.on("connect", (node) => {
    log.info(`Lavalink node "${node.id}" connected.`);
    nodeConnectedResolve?.();

    // node.sessionId right this instant may still be our stale persisted guess from before this
    // connection - the confirmed value only lands once the "ready" op (the very next WS message)
    // is processed, which is effectively instant on a healthy connection. The short delay avoids
    // a rare race where we'd otherwise call updateSession() against the wrong/replaced session.
    setTimeout(() => {
      void node
        .updateSession(true, SESSION_RESUME_TIMEOUT_MS)
        .then(() => {
          if (node.sessionId) savePersistedLavalinkSessionId(node.sessionId);
        })
        .catch((error) => log.warn(`Failed to enable Lavalink session resuming on node "${node.id}":`, error));
    }, 300);
  });

  manager.nodeManager.on("resumed", (node, _payload, playersResult) => {
    void (async () => {
      try {
        if (!Array.isArray(playersResult)) {
          log.warn(`Lavalink node "${node.id}" resumed its session but couldn't fetch the players still on it.`);
          return;
        }
        log.info(`Lavalink node "${node.id}" resumed its session with ${playersResult.length} still-live player(s).`);
        await reclaimResumedSessions(client, playersResult);
      } catch (error) {
        log.error("Failed to reclaim resumed music sessions:", error);
      } finally {
        resumedSignalResolve?.();
      }
    })();
  });

  manager.nodeManager.on("disconnect", (node, reason) => {
    log.warn(`Lavalink node "${node.id}" disconnected:`, reason);
  });

  manager.nodeManager.on("error", (node, error) => {
    log.error(`Lavalink node "${node.id}" error:`, error);
  });

  // playerDestroy handling (voice registry release, 24/7 reconnect, session cleanup) lives in
  // events.ts alongside the rest of the playback-lifecycle logic.
  registerPlayerEvents(client, manager);

  client.once(Events.ClientReady, (ready) => {
    void (async () => {
      try {
        await manager?.init({ id: ready.user.id, username: ready.user.username });
        // init() only kicks off the connection - it doesn't wait for the socket to actually open,
        // so resumeSessionsOnBoot would otherwise run before there's a node to talk to at all.
        await Promise.race([nodeConnected, delay(20_000)]);
        // If the "ready" handshake says resumed, reclaimResumedSessions needs a moment to finish
        // (it's a REST fetch plus per-guild work) before the DB fallback below runs, so it can see
        // which guilds are already handled instead of duplicating (or fighting) that work.
        await Promise.race([resumedSignal, delay(1500)]);
        await resumeSessionsOnBoot(client);
      } catch (error) {
        log.error("Failed to initialize Lavalink manager:", error);
      }
    })();
  });

  return manager;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getExistingPlayer(guildId: string): Player | undefined {
  return manager?.getPlayer(guildId);
}

export type LavalinkStatusSummary = {
  connected: boolean;
  players: number;
  playingPlayers: number;
  uptimeSeconds: number;
  memory: { freeMb: number; usedMb: number; allocatedMb: number; reservableMb: number } | null;
  cpu: { cores: number; systemLoadPct: number; lavalinkLoadPct: number } | null;
};

/** For the public status page — null when the bot isn't configured for music at all (nothing to
 *  report, not a failure), otherwise a snapshot of the one "main" node's live stats. `node.stats`
 *  is kept current automatically by lavalink-client via the node's stats websocket op, so this is
 *  just reading already-pushed data, not triggering a fresh request. */
export function getLavalinkStatusSummary(): LavalinkStatusSummary | null {
  if (!isLavalinkConfigured() || !manager) return null;

  const node = manager.nodeManager.nodes.get("main");
  if (!node?.connected) {
    return { connected: false, players: 0, playingPlayers: 0, uptimeSeconds: 0, memory: null, cpu: null };
  }

  const stats = node.stats;
  if (!stats) {
    // Connected, but the first stats push hasn't arrived yet.
    return { connected: true, players: 0, playingPlayers: 0, uptimeSeconds: 0, memory: null, cpu: null };
  }

  const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  const toPct = (fraction: number) => Math.round(fraction * 1000) / 10;

  return {
    connected: true,
    players: stats.players,
    playingPlayers: stats.playingPlayers,
    uptimeSeconds: Math.round(stats.uptime / 1000),
    memory: {
      freeMb: toMb(stats.memory.free),
      usedMb: toMb(stats.memory.used),
      allocatedMb: toMb(stats.memory.allocated),
      reservableMb: toMb(stats.memory.reservable),
    },
    cpu: {
      cores: stats.cpu.cores,
      systemLoadPct: toPct(stats.cpu.systemLoad),
      lavalinkLoadPct: toPct(stats.cpu.lavalinkLoad),
    },
  };
}
