import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDatabasePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./data/dreamliner.db";
  if (url.startsWith("file:")) {
    return url.slice("file:".length);
  }
  throw new Error("Only SQLite file URLs are supported in this version. Set DATABASE_URL=file:./data/dreamliner.db");
}

export function getDb() {
  if (!db) {
    const sqlite = new Database(getDatabasePath());
    sqlite.pragma("journal_mode = WAL");
    db = drizzle(sqlite, { schema });
  }
  return db;
}

export function closeDb() {
  if (db) {
    const sqlite = (db as unknown as { session: { client: Database.Database } }).session?.client;
    sqlite?.close();
    db = null;
  }
}
