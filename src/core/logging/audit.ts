import {
  AuditLogEvent,
  type Guild,
  type GuildAuditLogsEntry,
} from "discord.js";

type AuditCacheEntry = {
  at: number;
  entries: GuildAuditLogsEntry[];
};

const cache = new Map<string, AuditCacheEntry>();
const CACHE_TTL_MS = 8_000;

async function fetchRecent(
  guild: Guild,
  type: AuditLogEvent,
): Promise<GuildAuditLogsEntry[]> {
  const key = `${guild.id}:${type}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;

  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    const entries = [...logs.entries.values()];
    cache.set(key, { at: Date.now(), entries });
    return entries;
  } catch {
    return hit?.entries ?? [];
  }
}

function matchEntry(
  entries: GuildAuditLogsEntry[],
  options: {
    targetId?: string | null;
    maxAgeMs?: number;
  },
): GuildAuditLogsEntry | null {
  const maxAgeMs = options.maxAgeMs ?? 15_000;
  const now = Date.now();
  for (const entry of entries) {
    if (options.targetId && entry.targetId !== options.targetId) continue;
    const created = entry.createdTimestamp ?? 0;
    if (created && now - created > maxAgeMs) continue;
    return entry;
  }
  return null;
}

export async function findAuditExecutor(
  guild: Guild,
  type: AuditLogEvent,
  options: { targetId?: string | null; maxAgeMs?: number } = {},
): Promise<{ id: string; name: string | null } | null> {
  const entries = await fetchRecent(guild, type);
  const entry = matchEntry(entries, options);
  if (!entry?.executorId) return null;
  return {
    id: entry.executorId,
    name: entry.executor?.username ?? null,
  };
}

export async function findKickOrBanReason(
  guild: Guild,
  type: AuditLogEvent.MemberKick | AuditLogEvent.MemberBanAdd,
  targetId: string,
): Promise<{ executorId: string | null; reason: string | null } | null> {
  const entries = await fetchRecent(guild, type);
  const entry = matchEntry(entries, { targetId, maxAgeMs: 20_000 });
  if (!entry) return null;
  return {
    executorId: entry.executorId ?? null,
    reason: entry.reason ?? null,
  };
}
