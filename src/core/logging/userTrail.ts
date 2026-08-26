import { and, desc, eq, lte } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { guildUserTrail } from "../../db/schema.js";
import { getContentRetentionDays } from "../contentRetention.js";

const GAP_MS = 15 * 60 * 1000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function trailSnippet(content: string | null | undefined): string {
  const cleaned = (content ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned;
}

export async function recordUserTrail(
  guildId: string,
  userId: string,
  channelId: string,
  content?: string | null,
): Promise<void> {
  if (!guildId || !userId || !channelId) return;
  const db = getDb();
  const now = new Date();
  const retentionDays = await getContentRetentionDays(userId);
  const snippet = retentionDays <= 0 ? "" : trailSnippet(content);

  const last = await db
    .select()
    .from(guildUserTrail)
    .where(and(eq(guildUserTrail.guildId, guildId), eq(guildUserTrail.userId, userId)))
    .orderBy(desc(guildUserTrail.endedAt))
    .limit(1)
    .get();

  const lastEnded = last?.endedAt instanceof Date ? last.endedAt.getTime() : Number(last?.endedAt ?? 0);
  const sameBurst =
    last &&
    last.channelId === channelId &&
    Number.isFinite(lastEnded) &&
    now.getTime() - lastEnded < GAP_MS;

  if (sameBurst && last) {
    // Never fall back to a merged row's previous snippet for a 0-retention user —
    // that snippet could predate them turning retention off.
    const mergedSnippet = retentionDays <= 0 ? "" : snippet || last.snippet;
    await db
      .update(guildUserTrail)
      .set({
        endedAt: now,
        messageCount: last.messageCount + 1,
        snippet: mergedSnippet,
      })
      .where(eq(guildUserTrail.id, last.id));
  } else {
    await db.insert(guildUserTrail).values({
      guildId,
      userId,
      channelId,
      startedAt: now,
      endedAt: now,
      messageCount: 1,
      snippet,
    });
  }

  if (Math.random() < 0.02) {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    await db.delete(guildUserTrail).where(and(eq(guildUserTrail.guildId, guildId), lte(guildUserTrail.endedAt, cutoff)));
  }
}
