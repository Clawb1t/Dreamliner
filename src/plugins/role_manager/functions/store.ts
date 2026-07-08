import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { managedRoles } from "../../../db/schema.js";

export type ManagedRole = {
  id: number;
  guildId: string;
  name: string;
  template: string;
  createdAt: Date;
};

export async function listManagedRoles(guildId: string): Promise<ManagedRole[]> {
  const rows = await getDb()
    .select()
    .from(managedRoles)
    .where(eq(managedRoles.guildId, guildId))
    .orderBy(desc(managedRoles.createdAt))
    .all();

  return rows.map((row) => ({
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    template: row.template,
    createdAt: row.createdAt,
  }));
}

export async function getManagedRole(guildId: string, name: string): Promise<ManagedRole | undefined> {
  const row = await getDb()
    .select()
    .from(managedRoles)
    .where(and(eq(managedRoles.guildId, guildId), eq(managedRoles.name, name)))
    .get();

  if (!row) return undefined;
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    template: row.template,
    createdAt: row.createdAt,
  };
}

export async function createManagedRole(guildId: string, name: string, template: string): Promise<ManagedRole> {
  const result = await getDb()
    .insert(managedRoles)
    .values({
      guildId,
      name,
      template,
      createdAt: new Date(),
    })
    .returning();

  const row = result[0]!;
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    template: row.template,
    createdAt: row.createdAt,
  };
}

export async function deleteManagedRole(guildId: string, name: string): Promise<boolean> {
  const existing = await getManagedRole(guildId, name);
  if (!existing) return false;

  await getDb().delete(managedRoles).where(eq(managedRoles.id, existing.id));
  return true;
}
