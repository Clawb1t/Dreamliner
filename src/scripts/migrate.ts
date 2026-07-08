import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDb } from "../db/client.js";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations() {
  const dbPath = process.env.DATABASE_URL?.startsWith("file:")
    ? process.env.DATABASE_URL.slice("file:".length)
    : "./data/dreamliner.db";

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const migrationsDir = join(__dirname, "../../drizzle/migrations");
  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, { recursive: true });
  }

  const sqlite = getDb();
  const raw = (sqlite as unknown as { session: { client: Database.Database } }).session.client;

  raw.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at INTEGER
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const hash = file;
    const existing = raw.prepare("SELECT id FROM __drizzle_migrations WHERE hash = ?").get(hash);
    if (existing) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    raw.exec(sql);
    raw.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(hash, Date.now());
  }

  if (files.length === 0) {
    raw.exec(`
      CREATE TABLE IF NOT EXISTS guild_configs (
        guild_id TEXT PRIMARY KEY NOT NULL,
        config_yaml TEXT NOT NULL,
        user_config_yaml TEXT,
        defaults_snapshot_yaml TEXT,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS message_archives (
        id TEXT PRIMARY KEY NOT NULL,
        guild_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mod_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        mod_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reason TEXT,
        active INTEGER DEFAULT 1 NOT NULL,
        expires_at INTEGER,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guild_message_counts (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        count INTEGER DEFAULT 0 NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS user_message_counts (
        user_id TEXT PRIMARY KEY NOT NULL,
        count INTEGER DEFAULT 0 NOT NULL
      );
    `);
  }
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  runMigrations();
  console.log("Migrations complete.");
}
