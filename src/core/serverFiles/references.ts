import type Database from "better-sqlite3";
import { serverFilesDb, type ServerFile } from "./store.js";

/**
 * Where a server's files are used, worked out on demand from what the server has saved.
 *
 * Computed rather than kept in a reference table: image links are written by a dozen save paths
 * (plugin settings, custom commands, Message Kits, quizzes, giveaways, Autopilot, imports and
 * snapshot restores), and an index any one of them forgot to update would let "unused" files be
 * deleted out from under a live message. One server's saved data is small, so a scan per request
 * is cheap and can never go stale. A file counts as used where its id (in its link) or the id its
 * older store used (Message Kits `asset:<id>`, Welcomer/page `background_asset_id`, character
 * avatars) appears.
 */

export type FileUsage = { label: string; section: string };

type Doc = { label: string; section: string; text: string };

const PLUGIN_LABELS: Record<string, string> = {
  welcome_message: "Welcomer",
  tickets: "Tickets",
  giveaways: "Giveaways",
  suggestions: "Suggestions",
  persist: "Persist",
  autoreplies: "Autoreplies",
  autothreads: "Autothreads",
  role_panels: "Role panels",
  social: "Notifications",
  starboard: "Starboard",
  passport: "Passport",
  appeals: "Appeals",
  team_control: "Team Control",
  applications: "Applications",
  birthdays: "Birthdays",
  activity_rewards: "Activity Rewards",
  message_kits: "Message Kits",
  quizzes: "Quizzes",
  leveling: "Leveling",
  boosters: "Booster roles",
};

function pluginLabel(key: string): string {
  return PLUGIN_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function safeAll<T>(db: Database.Database, sql: string, ...params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return []; // A table or column this build doesn't have.
  }
}

/** Every saved thing in one server that can hold an image link, as searchable text. */
export function collectDocs(guildId: string, db: Database.Database = serverFilesDb()): Doc[] {
  const docs: Doc[] = [];

  for (const row of safeAll<{ user_config_json: string | null; config_json: string | null }>(
    db,
    "SELECT user_config_json, config_json FROM guild_configs WHERE guild_id = ?",
    guildId,
  )) {
    const raw = row.user_config_json || row.config_json || "";
    try {
      const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> } & Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed.plugins ?? {})) {
        docs.push({ label: `${pluginLabel(key)} settings`, section: `plugin:${key}`, text: JSON.stringify(value) });
      }
      const { plugins: _plugins, ...rest } = parsed;
      docs.push({ label: "Server settings", section: "server", text: JSON.stringify(rest) });
    } catch {
      docs.push({ label: "Plugin settings", section: "server", text: raw });
    }
  }

  for (const r of safeAll<{ name: string; program: string }>(db, "SELECT name, program FROM dream_commands WHERE guild_id = ?", guildId)) {
    docs.push({ label: `/${r.name} command`, section: "commands", text: r.program ?? "" });
  }
  for (const r of safeAll<{ name: string; document: string }>(db, "SELECT name, document FROM message_kits WHERE guild_id = ?", guildId)) {
    docs.push({ label: `Message Kit "${r.name}"`, section: "plugin:message_kits", text: r.document ?? "" });
  }
  const quizTitles = new Map<number, string>();
  for (const r of safeAll<{ id: number; title: string; cover_image_url: string; settings: string; outcomes: string }>(
    db,
    "SELECT id, title, cover_image_url, settings, outcomes FROM quizzes WHERE guild_id = ?",
    guildId,
  )) {
    quizTitles.set(r.id, r.title);
    docs.push({ label: `Quiz "${r.title}"`, section: "plugin:quizzes", text: `${r.cover_image_url ?? ""} ${r.settings ?? ""} ${r.outcomes ?? ""}` });
  }
  for (const r of safeAll<{ quiz_id: number; image_url: string; options: string }>(
    db,
    "SELECT quiz_id, image_url, options FROM quiz_questions WHERE guild_id = ?",
    guildId,
  )) {
    docs.push({ label: `Quiz "${quizTitles.get(r.quiz_id) ?? "question"}"`, section: "plugin:quizzes", text: `${r.image_url ?? ""} ${r.options ?? ""}` });
  }
  for (const r of safeAll<{ prize: string; title: string; embed_config: string }>(
    db,
    // Ended ones too: their posted messages still show the image.
    "SELECT prize, title, embed_config FROM giveaways WHERE guild_id = ?",
    guildId,
  )) {
    docs.push({ label: `Giveaway "${r.title || r.prize}"`, section: "plugin:giveaways", text: r.embed_config ?? "" });
  }
  for (const r of safeAll<{ name: string; settings: string }>(db, "SELECT name, settings FROM giveaway_templates WHERE guild_id = ?", guildId)) {
    docs.push({ label: `Giveaway template "${r.name}"`, section: "plugin:giveaways", text: r.settings ?? "" });
  }
  for (const r of safeAll<{ name: string; content: string }>(db, "SELECT name, content FROM tags WHERE guild_id = ?", guildId)) {
    docs.push({ label: `Tag "${r.name}"`, section: "plugin:tags", text: r.content ?? "" });
  }
  for (const r of safeAll<{ message: string; options: string }>(db, "SELECT message, options FROM feed_subscriptions WHERE guild_id = ?", guildId)) {
    docs.push({ label: "Notifications feed", section: "plugin:social", text: `${r.message ?? ""} ${r.options ?? ""}` });
  }
  for (const r of safeAll<{ handle: string; message_content: string; options: string }>(
    db,
    "SELECT handle, message_content, options FROM bluesky_feeds WHERE guild_id = ?",
    guildId,
  )) {
    docs.push({ label: `Bluesky feed @${r.handle}`, section: "plugin:bluesky", text: `${r.message_content ?? ""} ${r.options ?? ""}` });
  }
  for (const r of safeAll<{ name: string; avatar_url: string; avatar_asset_id: string }>(
    db,
    "SELECT name, avatar_url, avatar_asset_id FROM characters WHERE guild_id = ?",
    guildId,
  )) {
    docs.push({ label: `Character "${r.name}"`, section: "plugin:characters", text: `${r.avatar_url ?? ""} ${r.avatar_asset_id ?? ""}` });
  }
  return docs;
}

/** What identifies a file inside saved data: its own id, plus its older store's id. */
export function fileTokens(file: Pick<ServerFile, "id" | "legacyRef">): string[] {
  const tokens = [file.id];
  if (file.legacyRef) tokens.push(file.legacyRef.replace(/^asset:/, ""));
  return tokens.filter((t) => t.length >= 12);
}

/** Usage per file id (files with no usage have an empty list). */
export function computeUsage(guildId: string, files: Pick<ServerFile, "id" | "legacyRef">[], db?: Database.Database): Map<string, FileUsage[]> {
  const docs = collectDocs(guildId, db);
  const out = new Map<string, FileUsage[]>();
  for (const file of files) {
    const tokens = fileTokens(file);
    const seen = new Set<string>();
    const uses: FileUsage[] = [];
    for (const doc of docs) {
      if (seen.has(doc.label)) continue;
      if (tokens.some((t) => doc.text.includes(t))) {
        seen.add(doc.label);
        uses.push({ label: doc.label, section: doc.section });
      }
    }
    out.set(file.id, uses);
  }
  return out;
}
