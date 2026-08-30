import type { Guild } from "discord.js";
import { getUserNameHistory, searchNameHistory, type NameHistoryEntry } from "../plugins/name_history/functions/store.js";

export type WebNameHistoryEntry = {
  id: number;
  oldName: string;
  newName: string;
  changeType: string;
  changedAt: string;
  changedBy: WebNameHistoryPerson | null;
};

export type WebNameHistoryPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

async function resolvePerson(guild: Guild, userId: string): Promise<WebNameHistoryPerson> {
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  return {
    id: userId,
    name: member?.displayName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

async function resolvePeopleMap(guild: Guild, ids: string[]): Promise<Map<string, WebNameHistoryPerson>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const entries = await Promise.all(unique.map(async (id) => [id, await resolvePerson(guild, id)] as const));
  return new Map(entries);
}

function toWebEntry(entry: NameHistoryEntry, people: Map<string, WebNameHistoryPerson>): WebNameHistoryEntry {
  return {
    id: entry.id,
    oldName: entry.oldName,
    newName: entry.newName,
    changeType: entry.changeType,
    changedAt: entry.changedAt.toISOString(),
    changedBy: entry.changedBy ? (people.get(entry.changedBy) ?? null) : null,
  };
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

export function parseWebNameHistoryLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw)));
}

/** Full nickname/username history for one member of this guild, newest first. */
export async function getWebUserNameHistory(
  guild: Guild,
  userId: string,
  limit: number,
): Promise<{ user: WebNameHistoryPerson; entries: WebNameHistoryEntry[] }> {
  const entries = await getUserNameHistory(guild.id, userId, limit);
  const people = await resolvePeopleMap(guild, [userId, ...entries.map((e) => e.changedBy ?? "")]);
  const user = people.get(userId) ?? (await resolvePerson(guild, userId));
  return { user, entries: entries.map((entry) => toWebEntry(entry, people)) };
}

/** Search across the guild's recorded name changes by user id or name fragment. */
export async function searchWebNameHistory(
  guild: Guild,
  query: string,
  limit: number,
): Promise<{ entries: (WebNameHistoryEntry & { user: WebNameHistoryPerson })[] }> {
  const rows = await searchNameHistory(guild.id, query, limit);
  const people = await resolvePeopleMap(guild, [
    ...rows.map((r) => r.userId),
    ...rows.map((r) => r.changedBy ?? ""),
  ]);
  return {
    entries: rows.map((row) => ({
      ...toWebEntry(row, people),
      user: people.get(row.userId) ?? { id: row.userId, name: row.userId, username: null, avatar: null },
    })),
  };
}
