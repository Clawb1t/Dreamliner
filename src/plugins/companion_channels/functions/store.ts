import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { companionRooms } from "../../../db/schema.js";

export type CompanionRoomRow = {
  guildId: string;
  channelId: string;
  ownerId: string;
  setupId: string;
  textChannelId: string;
  interfaceMessageId: string;
  locked: boolean;
  ghosted: boolean;
  seq: number;
};

function mapRow(row: typeof companionRooms.$inferSelect): CompanionRoomRow {
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    ownerId: row.ownerId ?? "",
    setupId: row.setupId ?? "",
    textChannelId: row.textChannelId ?? "",
    interfaceMessageId: row.interfaceMessageId ?? "",
    locked: Boolean(row.locked),
    ghosted: Boolean(row.ghosted),
    seq: row.seq ?? 0,
  };
}

export async function listGuildRooms(guildId: string): Promise<CompanionRoomRow[]> {
  const rows = await getDb().select().from(companionRooms).where(eq(companionRooms.guildId, guildId)).all();
  return rows.map(mapRow);
}

export async function listSetupRooms(guildId: string, setupId: string): Promise<CompanionRoomRow[]> {
  const rows = await getDb()
    .select()
    .from(companionRooms)
    .where(and(eq(companionRooms.guildId, guildId), eq(companionRooms.setupId, setupId)))
    .all();
  return rows.map(mapRow);
}

export async function getRoomByChannel(guildId: string, channelId: string): Promise<CompanionRoomRow | null> {
  const row = await getDb()
    .select()
    .from(companionRooms)
    .where(and(eq(companionRooms.guildId, guildId), eq(companionRooms.channelId, channelId)))
    .get();
  return row ? mapRow(row) : null;
}

export async function getOwnedRoom(guildId: string, ownerId: string): Promise<CompanionRoomRow | null> {
  if (!ownerId) return null;
  const row = await getDb()
    .select()
    .from(companionRooms)
    .where(and(eq(companionRooms.guildId, guildId), eq(companionRooms.ownerId, ownerId)))
    .get();
  return row ? mapRow(row) : null;
}

export async function nextSetupSeq(guildId: string, setupId: string): Promise<number> {
  const row = await getDb()
    .select({ max: sql<number>`max(${companionRooms.seq})` })
    .from(companionRooms)
    .where(and(eq(companionRooms.guildId, guildId), eq(companionRooms.setupId, setupId)))
    .get();
  const current = typeof row?.max === "number" ? row.max : Number(row?.max ?? 0);
  return (Number.isFinite(current) ? current : 0) + 1;
}

export async function insertRoom(row: CompanionRoomRow): Promise<void> {
  await getDb()
    .insert(companionRooms)
    .values({
      guildId: row.guildId,
      channelId: row.channelId,
      ownerId: row.ownerId,
      setupId: row.setupId,
      textChannelId: row.textChannelId,
      interfaceMessageId: row.interfaceMessageId,
      locked: row.locked,
      ghosted: row.ghosted,
      seq: row.seq,
    })
    .onConflictDoUpdate({
      target: [companionRooms.guildId, companionRooms.channelId],
      set: {
        ownerId: row.ownerId,
        setupId: row.setupId,
        textChannelId: row.textChannelId,
        interfaceMessageId: row.interfaceMessageId,
        locked: row.locked,
        ghosted: row.ghosted,
        seq: row.seq,
      },
    });
}

export async function updateRoom(
  guildId: string,
  channelId: string,
  patch: Partial<Omit<CompanionRoomRow, "guildId" | "channelId">>,
): Promise<void> {
  const current = await getRoomByChannel(guildId, channelId);
  if (!current) return;
  const next = { ...current, ...patch };
  await getDb()
    .update(companionRooms)
    .set({
      ownerId: next.ownerId,
      setupId: next.setupId,
      textChannelId: next.textChannelId,
      interfaceMessageId: next.interfaceMessageId,
      locked: next.locked,
      ghosted: next.ghosted,
      seq: next.seq,
    })
    .where(and(eq(companionRooms.guildId, guildId), eq(companionRooms.channelId, channelId)));
}

export async function removeRoom(guildId: string, channelId: string): Promise<void> {
  await getDb()
    .delete(companionRooms)
    .where(and(eq(companionRooms.guildId, guildId), eq(companionRooms.channelId, channelId)));
}

export async function removeGuildRoomsForSetup(guildId: string, setupId: string): Promise<CompanionRoomRow[]> {
  const rooms = await listSetupRooms(guildId, setupId);
  await getDb()
    .delete(companionRooms)
    .where(and(eq(companionRooms.guildId, guildId), eq(companionRooms.setupId, setupId)));
  return rooms;
}
