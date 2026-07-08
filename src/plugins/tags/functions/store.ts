import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { tags } from "../../../db/schema.js";

export type TagRow = {
  guildId: string;
  name: string;
  content: string;
  createdBy: string;
  createdAt: Date;
};

export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase();
}

export async function getTag(guildId: string, name: string): Promise<TagRow | null> {
  const row = await getDb()
    .select()
    .from(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.name, normalizeTagName(name))))
    .get();
  if (!row) return null;
  return row;
}

export async function listTags(guildId: string): Promise<TagRow[]> {
  return getDb().select().from(tags).where(eq(tags.guildId, guildId)).all();
}

export async function createTag(input: {
  guildId: string;
  name: string;
  content: string;
  createdBy: string;
}): Promise<TagRow> {
  const name = normalizeTagName(input.name);
  const row = await getDb()
    .insert(tags)
    .values({
      guildId: input.guildId,
      name,
      content: input.content,
      createdBy: input.createdBy,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return row;
}

export async function updateTag(guildId: string, name: string, content: string): Promise<boolean> {
  const result = await getDb()
    .update(tags)
    .set({ content })
    .where(and(eq(tags.guildId, guildId), eq(tags.name, normalizeTagName(name))))
    .returning()
    .get();
  return Boolean(result);
}

export async function deleteTag(guildId: string, name: string): Promise<boolean> {
  const result = await getDb()
    .delete(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.name, normalizeTagName(name))))
    .returning()
    .get();
  return Boolean(result);
}
