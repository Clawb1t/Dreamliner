import { eq, and } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { selfRolePanels } from "../../../db/schema.js";
import type { SelfRolePanelConfig } from "../defaultOverrides.js";

export type SelfRolePanel = {
  guildId: string;
  messageId: string;
  config: SelfRolePanelConfig;
};

export async function getSelfRolePanel(guildId: string, messageId: string): Promise<SelfRolePanel | undefined> {
  const row = await getDb()
    .select()
    .from(selfRolePanels)
    .where(and(eq(selfRolePanels.guildId, guildId), eq(selfRolePanels.messageId, messageId)))
    .get();

  if (!row) return undefined;
  return {
    guildId: row.guildId,
    messageId: row.messageId,
    config: JSON.parse(row.config) as SelfRolePanelConfig,
  };
}

export async function upsertSelfRolePanel(guildId: string, messageId: string, config: SelfRolePanelConfig): Promise<void> {
  await getDb()
    .insert(selfRolePanels)
    .values({
      guildId,
      messageId,
      config: JSON.stringify(config),
    })
    .onConflictDoUpdate({
      target: [selfRolePanels.guildId, selfRolePanels.messageId],
      set: { config: JSON.stringify(config) },
    });
}

export async function deleteSelfRolePanel(guildId: string, messageId: string): Promise<boolean> {
  const result = await getDb()
    .delete(selfRolePanels)
    .where(and(eq(selfRolePanels.guildId, guildId), eq(selfRolePanels.messageId, messageId)));
  return (result.changes ?? 0) > 0;
}
