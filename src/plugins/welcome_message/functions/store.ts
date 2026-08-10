import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { welcomeJoinMessages } from "../../../db/schema.js";

export type WelcomeJoinMessageRow = {
  messageId: string;
  guildId: string;
  channelId: string;
  memberId: string;
  createdAt: Date;
  waveEnabled: boolean;
  waveCount: number;
  waverIds: string[];
};

function parseWavers(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && Boolean(id));
  } catch {
    return [];
  }
}

function mapRow(row: {
  messageId: string;
  guildId: string;
  channelId: string;
  memberId: string;
  createdAt: Date;
  waveEnabled: boolean;
  waveCount: number;
  waverIds: string;
}): WelcomeJoinMessageRow {
  return {
    messageId: row.messageId,
    guildId: row.guildId,
    channelId: row.channelId,
    memberId: row.memberId,
    createdAt: row.createdAt,
    waveEnabled: Boolean(row.waveEnabled),
    waveCount: row.waveCount ?? 0,
    waverIds: parseWavers(row.waverIds),
  };
}

export async function trackWelcomeJoinMessage(input: {
  messageId: string;
  guildId: string;
  channelId: string;
  memberId: string;
  waveEnabled: boolean;
}): Promise<void> {
  const db = getDb();
  await db
    .insert(welcomeJoinMessages)
    .values({
      messageId: input.messageId,
      guildId: input.guildId,
      channelId: input.channelId,
      memberId: input.memberId,
      createdAt: new Date(),
      waveEnabled: input.waveEnabled,
      waveCount: 0,
      waverIds: "[]",
    })
    .onConflictDoUpdate({
      target: welcomeJoinMessages.messageId,
      set: {
        guildId: input.guildId,
        channelId: input.channelId,
        memberId: input.memberId,
        createdAt: new Date(),
        waveEnabled: input.waveEnabled,
        waveCount: 0,
        waverIds: "[]",
      },
    });
}

export async function getWelcomeJoinMessage(messageId: string): Promise<WelcomeJoinMessageRow | null> {
  const row = await getDb()
    .select()
    .from(welcomeJoinMessages)
    .where(eq(welcomeJoinMessages.messageId, messageId))
    .get();
  return row ? mapRow(row) : null;
}

export async function listRecentWelcomeJoinMessages(
  guildId: string,
  memberId: string,
  since: Date,
): Promise<WelcomeJoinMessageRow[]> {
  const rows = await getDb()
    .select()
    .from(welcomeJoinMessages)
    .where(
      and(eq(welcomeJoinMessages.guildId, guildId), eq(welcomeJoinMessages.memberId, memberId)),
    )
    .all();
  return rows.map(mapRow).filter((row) => row.createdAt.getTime() >= since.getTime());
}

export async function addWelcomeWave(
  messageId: string,
  waverId: string,
): Promise<{ ok: true; row: WelcomeJoinMessageRow } | { ok: false; reason: "missing" | "disabled" | "duplicate" }> {
  const existing = await getWelcomeJoinMessage(messageId);
  if (!existing) return { ok: false, reason: "missing" };
  if (!existing.waveEnabled) return { ok: false, reason: "disabled" };
  if (existing.waverIds.includes(waverId)) return { ok: false, reason: "duplicate" };

  const waverIds = [...existing.waverIds, waverId];
  const waveCount = waverIds.length;
  await getDb()
    .update(welcomeJoinMessages)
    .set({
      waveCount,
      waverIds: JSON.stringify(waverIds),
    })
    .where(eq(welcomeJoinMessages.messageId, messageId));

  return {
    ok: true,
    row: { ...existing, waveCount, waverIds },
  };
}

export async function deleteWelcomeJoinMessage(messageId: string): Promise<void> {
  await getDb().delete(welcomeJoinMessages).where(eq(welcomeJoinMessages.messageId, messageId));
}

export async function pruneOldWelcomeJoinMessages(before: Date): Promise<void> {
  await getDb().delete(welcomeJoinMessages).where(lt(welcomeJoinMessages.createdAt, before));
}
