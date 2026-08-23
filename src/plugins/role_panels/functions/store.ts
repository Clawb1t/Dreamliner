import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { rolePanelMessages } from "../../../db/schema.js";

export type RolePanelMessageRow = {
  guildId: string;
  panelId: string;
  channelId: string;
  messageId: string;
  postMode: "bot" | "existing";
  fingerprint: string;
  appliedRoleIds: string[];
};

function toRow(row: typeof rolePanelMessages.$inferSelect): RolePanelMessageRow {
  let appliedRoleIds: string[] = [];
  try {
    const parsed = JSON.parse(row.appliedRoleIds) as unknown;
    if (Array.isArray(parsed)) appliedRoleIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // leave empty on corrupt/legacy data
  }
  return {
    guildId: row.guildId,
    panelId: row.panelId,
    channelId: row.channelId,
    messageId: row.messageId,
    postMode: row.postMode === "existing" ? "existing" : "bot",
    fingerprint: row.fingerprint,
    appliedRoleIds,
  };
}

export async function listRolePanelMessages(guildId: string): Promise<RolePanelMessageRow[]> {
  const rows = await getDb().select().from(rolePanelMessages).where(eq(rolePanelMessages.guildId, guildId)).all();
  return rows.map(toRow);
}

export async function getRolePanelMessage(guildId: string, panelId: string): Promise<RolePanelMessageRow | undefined> {
  const row = await getDb()
    .select()
    .from(rolePanelMessages)
    .where(and(eq(rolePanelMessages.guildId, guildId), eq(rolePanelMessages.panelId, panelId)))
    .get();
  return row ? toRow(row) : undefined;
}

/** Lookup used by the runtime reaction/button handlers to resolve an incoming message to its panel. */
export async function findRolePanelMessageByDiscordMessage(
  guildId: string,
  messageId: string,
): Promise<RolePanelMessageRow | undefined> {
  const row = await getDb()
    .select()
    .from(rolePanelMessages)
    .where(and(eq(rolePanelMessages.guildId, guildId), eq(rolePanelMessages.messageId, messageId)))
    .get();
  return row ? toRow(row) : undefined;
}

export async function upsertRolePanelMessage(input: {
  guildId: string;
  panelId: string;
  channelId: string;
  messageId: string;
  postMode: "bot" | "existing";
  fingerprint?: string;
  appliedRoleIds?: string[];
}): Promise<void> {
  const values = {
    guildId: input.guildId,
    panelId: input.panelId,
    channelId: input.channelId,
    messageId: input.messageId,
    postMode: input.postMode,
    fingerprint: input.fingerprint ?? "",
    appliedRoleIds: JSON.stringify(input.appliedRoleIds ?? []),
  };
  await getDb()
    .insert(rolePanelMessages)
    .values(values)
    .onConflictDoUpdate({
      target: [rolePanelMessages.guildId, rolePanelMessages.panelId],
      set: {
        channelId: values.channelId,
        messageId: values.messageId,
        postMode: values.postMode,
        fingerprint: values.fingerprint,
        appliedRoleIds: values.appliedRoleIds,
      },
    });
}

export async function removeRolePanelMessage(guildId: string, panelId: string): Promise<void> {
  await getDb()
    .delete(rolePanelMessages)
    .where(and(eq(rolePanelMessages.guildId, guildId), eq(rolePanelMessages.panelId, panelId)));
}
