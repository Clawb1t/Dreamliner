import { and, desc, eq } from "drizzle-orm";
import type { Guild } from "discord.js";
import { getDb } from "../db/client.js";
import { guildUserTrail, logMessages } from "../db/schema.js";

const DISCORD_EPOCH = 1_420_070_400_000;
const GAP_MS = 15 * 60 * 1000;
const LOG_MESSAGE_SCAN = 400;

export type WebTrackerHop = {
  id: string;
  channelId: string;
  channelName: string | null;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  snippet: string;
};

export type WebTrackerPayload = {
  hops: WebTrackerHop[];
  totalMessages: number;
};

function snowflakeMs(id: string): number {
  try {
    return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
  } catch {
    return Date.now();
  }
}

function toIso(value: Date | number | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

function toMs(value: Date | number | string | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function snippetOf(content: string | null | undefined): string {
  const cleaned = (content ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned;
}

function channelName(guild: Guild, channelId: string, stored?: string | null): string | null {
  if (stored) return stored;
  const channel = guild.channels.cache.get(channelId);
  return channel && "name" in channel && channel.name ? channel.name : null;
}

type MutableHop = {
  channelId: string;
  channelName: string | null;
  startedMs: number;
  endedMs: number;
  messageCount: number;
  snippet: string;
};

function collapseMessages(
  guild: Guild,
  rows: Array<{
    channelId: string;
    channelName: string | null;
    messageId: string;
    content: string;
  }>,
): MutableHop[] {
  const chronological = [...rows].reverse();
  const hops: MutableHop[] = [];
  for (const row of chronological) {
    const at = snowflakeMs(row.messageId);
    const last = hops[hops.length - 1];
    if (last && last.channelId === row.channelId && at - last.endedMs < GAP_MS) {
      last.endedMs = at;
      last.messageCount += 1;
      const nextSnippet = snippetOf(row.content);
      if (nextSnippet) last.snippet = nextSnippet;
    } else {
      hops.push({
        channelId: row.channelId,
        channelName: channelName(guild, row.channelId, row.channelName),
        startedMs: at,
        endedMs: at,
        messageCount: 1,
        snippet: snippetOf(row.content),
      });
    }
  }
  return hops;
}

function mergeHops(primary: MutableHop[], secondary: MutableHop[]): MutableHop[] {
  const merged = [...primary, ...secondary].sort((a, b) => a.startedMs - b.startedMs);
  const out: MutableHop[] = [];
  for (const hop of merged) {
    const last = out[out.length - 1];
    const overlap =
      last &&
      last.channelId === hop.channelId &&
      hop.startedMs - last.endedMs < GAP_MS;
    if (overlap && last) {
      last.endedMs = Math.max(last.endedMs, hop.endedMs);
      last.startedMs = Math.min(last.startedMs, hop.startedMs);
      last.messageCount = Math.max(last.messageCount, hop.messageCount);
      if (hop.snippet && hop.snippet.length >= last.snippet.length) last.snippet = hop.snippet;
      if (!last.channelName && hop.channelName) last.channelName = hop.channelName;
    } else {
      out.push({ ...hop });
    }
  }
  return out;
}

export async function getWebUserTrail(
  guild: Guild,
  userId: string,
  limit = 80,
): Promise<WebTrackerPayload> {
  const db = getDb();
  let trailRows: Array<{
    channelId: string;
    startedAt: Date | number | string;
    endedAt: Date | number | string;
    messageCount: number;
    snippet: string;
  }> = [];
  try {
    trailRows = await db
      .select()
      .from(guildUserTrail)
      .where(and(eq(guildUserTrail.guildId, guild.id), eq(guildUserTrail.userId, userId)))
      .orderBy(desc(guildUserTrail.endedAt))
      .limit(Math.max(limit, 80));
  } catch {
    trailRows = [];
  }

  let messageRows: Array<{
    channelId: string;
    channelName: string | null;
    messageId: string;
    content: string;
  }> = [];
  try {
    messageRows = await db
      .select({
        channelId: logMessages.channelId,
        channelName: logMessages.channelName,
        messageId: logMessages.messageId,
        content: logMessages.content,
      })
      .from(logMessages)
      .where(and(eq(logMessages.guildId, guild.id), eq(logMessages.authorId, userId)))
      .orderBy(desc(logMessages.messageId))
      .limit(LOG_MESSAGE_SCAN);
  } catch {
    messageRows = [];
  }

  const trailHops: MutableHop[] = trailRows.map((row) => ({
    channelId: row.channelId,
    channelName: channelName(guild, row.channelId),
    startedMs: toMs(row.startedAt),
    endedMs: toMs(row.endedAt),
    messageCount: row.messageCount,
    snippet: row.snippet,
  }));
  const logHops = collapseMessages(guild, messageRows);
  const hops = mergeHops(trailHops, logHops)
    .sort((a, b) => b.endedMs - a.endedMs)
    .slice(0, limit);

  return {
    hops: hops.map((hop) => ({
      id: `chat:${hop.channelId}:${hop.startedMs}`,
      channelId: hop.channelId,
      channelName: hop.channelName,
      startedAt: toIso(hop.startedMs),
      endedAt: toIso(hop.endedMs),
      messageCount: hop.messageCount,
      snippet: hop.snippet,
    })),
    totalMessages: hops.reduce((sum, hop) => sum + hop.messageCount, 0),
  };
}
