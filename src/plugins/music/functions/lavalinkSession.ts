import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDatabasePath } from "../../../db/client.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("music");

/** Sits next to the sqlite DB file, same cwd-relative convention as DATABASE_URL. Tiny and
 *  disposable - worst case (missing/corrupt) is just a fresh Lavalink session on next boot,
 *  same as before this existed. */
function sessionFilePath(): string {
  return join(dirname(getDatabasePath()), "lavalink-session.json");
}

/** The Lavalink session id from our last connection, if any - passing this back into
 *  `node.connect(sessionId)` is what lets Lavalink recognize "this is the same client
 *  reconnecting" and hand back players that `updateSession(true, ...)` kept alive across the
 *  gap, instead of starting a brand new (empty) session. */
export function loadPersistedLavalinkSessionId(): string | undefined {
  try {
    const raw = readFileSync(sessionFilePath(), "utf8");
    const data = JSON.parse(raw) as { sessionId?: unknown };
    return typeof data.sessionId === "string" && data.sessionId ? data.sessionId : undefined;
  } catch {
    return undefined;
  }
}

export function savePersistedLavalinkSessionId(sessionId: string): void {
  try {
    const path = sessionFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sessionId }));
  } catch (error) {
    log.warn("Failed to persist Lavalink session id:", error);
  }
}
