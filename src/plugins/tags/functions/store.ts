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

export const TAG_MAX_NAME_LEN = 64;
export const TAG_MAX_CONTENT_LEN = 2000;

/** Shared by /tag and the dashboard bridge (webTags.ts) so both accept the same names/content. */
export function validateTagName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = normalizeTagName(raw);
  if (!name) return { ok: false, error: "Tag name is required." };
  if (name.length > TAG_MAX_NAME_LEN) {
    return { ok: false, error: `Tag name must be ${TAG_MAX_NAME_LEN} characters or fewer.` };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    return {
      ok: false,
      error: "Tag names must start with a letter or number and use only a-z, 0-9, _ or -.",
    };
  }
  return { ok: true, name };
}

export function validateTagContent(raw: string): { ok: true; content: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "Tag content is required." };
  }
  if (raw.length > TAG_MAX_CONTENT_LEN) {
    return { ok: false, error: `Tag content must be ${TAG_MAX_CONTENT_LEN} characters or fewer.` };
  }
  return { ok: true, content: raw };
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
