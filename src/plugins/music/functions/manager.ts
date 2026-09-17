import { Events, type Client } from "discord.js";
import { LavalinkManager, type Player } from "lavalink-client";
import { getLogger } from "../../../core/logger.js";
import { registerPlayerEvents } from "./events.js";
import { resumeSessionsOnBoot } from "./sessionPersistence.js";

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
    log.warn("LAVALINK_HOST/LAVALINK_PASSWORD not set — music plugin will stay idle until configured.");
  }

  manager = new LavalinkManager({
    nodes: [
      {
        id: "main",
        host: process.env.LAVALINK_HOST?.trim() || "127.0.0.1",
        port: Number(process.env.LAVALINK_PORT) || 2333,
        authorization: process.env.LAVALINK_PASSWORD?.trim() || "",
        secure: process.env.LAVALINK_SECURE?.trim().toLowerCase() === "true",
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

  manager.nodeManager.on("connect", (node) => {
    log.info(`Lavalink node "${node.id}" connected.`);
    // Not calling node.updateSession() here - this node is a shared public one, which reliably
    // rejects it ("not ready, or not up to date") and issuing it seemed to correlate with a
    // reconnect-cycling pattern. Resume-after-restart is instead handled entirely by the
    // DB-backed sessionPersistence.ts, which doesn't depend on the node granting a resume session.
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
    void manager
      ?.init({ id: ready.user.id, username: ready.user.username })
      .then(() => resumeSessionsOnBoot(client))
      .catch((error) => log.error("Failed to initialize Lavalink manager:", error));
  });

  return manager;
}

export function getExistingPlayer(guildId: string): Player | undefined {
  return manager?.getPlayer(guildId);
}
