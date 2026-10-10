import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-voice-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../../../db/client.js");
const { voiceActiveSessions } = await import("../../../db/schema.js");
const { snapshotActiveVoiceMembers } = await import("./voice.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* leftover temp dir is harmless */
  }
});

function clientWith(guilds: unknown[]): Client {
  return { guilds: { cache: new Map(guilds.map((g) => [(g as { id: string }).id, g])) } } as unknown as Client;
}

test("restart recovery before login keeps everyone's saved voice sessions", async () => {
  const joinedAt = new Date(Date.now() - 45 * 60_000);
  await getDb().insert(voiceActiveSessions).values({ guildId: "1", userId: "10", channelId: "100", joinedAt });

  // Plugins load before the client has logged in: it knows no guilds yet.
  await snapshotActiveVoiceMembers(clientWith([]));

  const rows = await getDb().select().from(voiceActiveSessions);
  assert.equal(rows.length, 1, "the saved session must survive a scan that saw nothing");
});

test("a scan only clears stale sessions in the guilds it actually looked at", async () => {
  await getDb().insert(voiceActiveSessions).values({ guildId: "2", userId: "20", channelId: "200", joinedAt: new Date() });

  // Guild 2 is visible with an empty voice channel list (user 20 left while the bot was down);
  // guild 1 isn't available yet.
  const guild2 = { id: "2", available: true, afkChannelId: null, channels: { cache: new Map() } };
  await snapshotActiveVoiceMembers(clientWith([guild2]));

  const rows = await getDb().select().from(voiceActiveSessions);
  assert.deepEqual(rows.map((row) => row.guildId).sort(), ["1"]);
});
