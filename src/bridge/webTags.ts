import { pluginEnabled } from "../core/pluginCommand.js";
import type { ConfigManager } from "../config/manager.js";
import {
  createTag,
  deleteTag,
  getTag,
  listTags,
  normalizeTagName,
  updateTag,
  type TagRow,
} from "../plugins/tags/functions/store.js";

const MAX_NAME_LEN = 64;
const MAX_CONTENT_LEN = 2000;

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

async function assertPluginEnabled(
  configManager: ConfigManager,
  guildId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "tags")) {
    return {
      ok: false,
      error: "The tags plugin is disabled for this server.",
      status: 403,
    };
  }
  return { ok: true };
}

function validateName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = normalizeTagName(raw);
  if (!name) return { ok: false, error: "Tag name is required." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Tag name must be ${MAX_NAME_LEN} characters or fewer.` };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    return {
      ok: false,
      error: "Tag names must start with a letter or number and use only a-z, 0-9, _ or -.",
    };
  }
  return { ok: true, name };
}

function validateContent(raw: string): { ok: true; content: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "Tag content is required." };
  }
  if (raw.length > MAX_CONTENT_LEN) {
    return { ok: false, error: `Tag content must be ${MAX_CONTENT_LEN} characters or fewer.` };
  }
  return { ok: true, content: raw };
}

export async function listBridgeTags(
  configManager: ConfigManager,
  guildId: string,
): Promise<
  | { ok: true; tags: BridgeTag[] }
  | { ok: false; error: string; status: number }
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const rows = await listTags(guildId);
  const tags = rows
    .map(serializeTag)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, tags };
}

export async function getBridgeTag(
  configManager: ConfigManager,
  guildId: string,
  name: string,
): Promise<
  | { ok: true; tag: BridgeTag }
  | { ok: false; error: string; status: number }
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const row = await getTag(guildId, name);
  if (!row) return { ok: false, error: "Tag not found.", status: 404 };
  return { ok: true, tag: serializeTag(row) };
}

export async function createBridgeTag(
  configManager: ConfigManager,
  guildId: string,
  input: { userId: string; name: string; content: string },
): Promise<
  | { ok: true; tag: BridgeTag }
  | { ok: false; error: string; status: number }
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

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
  configManager: ConfigManager,
  guildId: string,
  name: string,
  input: { content: string },
): Promise<
  | { ok: true; tag: BridgeTag }
  | { ok: false; error: string; status: number }
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

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
  configManager: ConfigManager,
  guildId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  const nameCheck = validateName(name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error, status: 400 };

  const deleted = await deleteTag(guildId, nameCheck.name);
  if (!deleted) return { ok: false, error: "Tag not found.", status: 404 };
  return { ok: true };
}
