import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { roleButtonPanels } from "../../../db/schema.js";

export type RoleButtonPanel = {
  guildId: string;
  messageId: string;
  roleId: string;
  label: string;
  style: string;
};

export async function listRoleButtonsForMessage(guildId: string, messageId: string): Promise<RoleButtonPanel[]> {
  const rows = await getDb()
    .select()
    .from(roleButtonPanels)
    .where(and(eq(roleButtonPanels.guildId, guildId), eq(roleButtonPanels.messageId, messageId)))
    .all();

  return rows.map((row) => ({
    guildId: row.guildId,
    messageId: row.messageId,
    roleId: row.roleId,
    label: row.label,
    style: row.style,
  }));
}

export async function getRoleButtonPanel(
  guildId: string,
  messageId: string,
  roleId: string,
): Promise<RoleButtonPanel | undefined> {
  const row = await getDb()
    .select()
    .from(roleButtonPanels)
    .where(
      and(
        eq(roleButtonPanels.guildId, guildId),
        eq(roleButtonPanels.messageId, messageId),
        eq(roleButtonPanels.roleId, roleId),
      ),
    )
    .get();

  if (!row) return undefined;
  return {
    guildId: row.guildId,
    messageId: row.messageId,
    roleId: row.roleId,
    label: row.label,
    style: row.style,
  };
}

export async function createRoleButtonPanel(input: RoleButtonPanel): Promise<void> {
  await getDb()
    .insert(roleButtonPanels)
    .values({
      guildId: input.guildId,
      messageId: input.messageId,
      roleId: input.roleId,
      label: input.label,
      style: input.style,
    })
    .onConflictDoUpdate({
      target: [roleButtonPanels.guildId, roleButtonPanels.messageId, roleButtonPanels.roleId],
      set: {
        label: input.label,
        style: input.style,
      },
    });
}

export async function deleteRoleButtonPanel(guildId: string, messageId: string, roleId: string): Promise<boolean> {
  const result = await getDb()
    .delete(roleButtonPanels)
    .where(
      and(
        eq(roleButtonPanels.guildId, guildId),
        eq(roleButtonPanels.messageId, messageId),
        eq(roleButtonPanels.roleId, roleId),
      ),
    );
  return (result.changes ?? 0) > 0;
}

export async function deleteRoleButtonPanelsForMessage(guildId: string, messageId: string): Promise<number> {
  const result = await getDb()
    .delete(roleButtonPanels)
    .where(and(eq(roleButtonPanels.guildId, guildId), eq(roleButtonPanels.messageId, messageId)));
  return result.changes ?? 0;
}
