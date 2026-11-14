import {
  createTag,
  deleteTag,
  getTag,
  listTags,
  updateTag,
  validateTagContent as validateContent,
  validateTagName as validateName,
  type TagRow,
} from "../plugins/tags/functions/store.js";

export type BridgeTag = {
  guildId: string;
  name: string;
  content: string;
  createdBy: string;
  createdAt: string;
};

function serializeTag(row: TagRow): BridgeTag {
  return {
    guildId: row.guildId,
    name: row.name,
    content: row.content,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listBridgeTags(
  guildId: string,
): Promise<
  | { ok: true; tags: BridgeTag[] }
  | { ok: false; error: string; status: number }
> {
  const rows = await listTags(guildId);
  const tags = rows
    .map(serializeTag)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, tags };
}

export async function getBridgeTag(
  guildId: string,
  name: string,
): Promise<
  | { ok: true; tag: BridgeTag }
  | { ok: false; error: string; status: number }
> {
  const row = await getTag(guildId, name);
  if (!row) return { ok: false, error: "Tag not found.", status: 404 };
  return { ok: true, tag: serializeTag(row) };
}

export async function createBridgeTag(
  guildId: string,
  input: { userId: string; name: string; content: string },
): Promise<
  | { ok: true; tag: BridgeTag }
  | { ok: false; error: string; status: number }
> {
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error, status: 400 };
  const contentCheck = validateContent(input.content);
  if (!contentCheck.ok) return { ok: false, error: contentCheck.error, status: 400 };

  const existing = await getTag(guildId, nameCheck.name);
  if (existing) {
    return { ok: false, error: `A tag named "${nameCheck.name}" already exists.`, status: 409 };
  }

  const row = await createTag({
    guildId,
    name: nameCheck.name,
    content: contentCheck.content,
    createdBy: input.userId,
  });
  return { ok: true, tag: serializeTag(row) };
}

export async function updateBridgeTag(
  guildId: string,
  name: string,
  input: { content: string },
): Promise<
  | { ok: true; tag: BridgeTag }
  | { ok: false; error: string; status: number }
> {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error, status: 400 };
  const contentCheck = validateContent(input.content);
  if (!contentCheck.ok) return { ok: false, error: contentCheck.error, status: 400 };

  const updated = await updateTag(guildId, nameCheck.name, contentCheck.content);
  if (!updated) return { ok: false, error: "Tag not found.", status: 404 };

  const row = await getTag(guildId, nameCheck.name);
  if (!row) return { ok: false, error: "Tag not found.", status: 404 };
  return { ok: true, tag: serializeTag(row) };
}

export async function deleteBridgeTag(
  guildId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error, status: 400 };

  const deleted = await deleteTag(guildId, nameCheck.name);
  if (!deleted) return { ok: false, error: "Tag not found.", status: 404 };
  return { ok: true };
}
