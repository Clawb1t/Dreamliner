import type { Client } from "discord.js";
import { compileDreamcode, DreamcodeError } from "../dreamcode/index.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import type { ConfigManager } from "../config/manager.js";
import {
  countSlashDreamCommands,
  createDreamCommand,
  deleteDreamCommand,
  getDreamCommand,
  isValidCommandName,
  listDreamCommands,
  MAX_SLASH_DREAM_COMMANDS,
  normalizeCommandName,
  updateDreamCommand,
  type DreamCommandRow,
} from "../plugins/dream_commands/functions/store.js";
import {
  DREAM_SLASH_CAP,
  isReservedCommandName,
  syncGuildDreamSlashCommands,
} from "../plugins/dream_commands/functions/guildSlash.js";

const MAX_SOURCE_BYTES = 32_000;

export type BridgeDreamCommand = {
  guildId: string;
  name: string;
  source: string;
  triggerType: string;
  minLevel: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
};

function serializeCommand(row: DreamCommandRow): BridgeDreamCommand {
  return {
    guildId: row.guildId,
    name: row.name,
    source: row.source,
    triggerType: row.triggerType,
    minLevel: row.minLevel,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    enabled: row.enabled,
  };
}

export type DreamCommandValidation =
  | { ok: true; source: string }
  | { ok: false; error: string; status: number };

function validateSource(source: string): DreamCommandValidation {
  if (typeof source !== "string" || !source.trim()) {
    return { ok: false, error: "source is required", status: 400 };
  }
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      error: `Dreamcode files must be under ${MAX_SOURCE_BYTES} bytes.`,
      status: 400,
    };
  }
  try {
    const program = compileDreamcode(source);
    if (program.trigger !== "slash") {
      return {
        ok: false,
        error:
          "Add `@slash` at the top of the file. Dreamcode commands are slash-only (`@prefix` is not supported).",
        status: 400,
      };
    }
    return { ok: true, source };
  } catch (err) {
    const message = err instanceof DreamcodeError ? err.message : "Invalid Dreamcode.";
    return { ok: false, error: message, status: 400 };
  }
}

async function assertPluginEnabled(
  configManager: ConfigManager,
  guildId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "dream_commands")) {
    return {
      ok: false,
      error: "The dream_commands plugin is disabled for this server.",
      status: 403,
    };
  }
  return { ok: true };
}

export async function listBridgeDreamCommands(
  configManager: ConfigManager,
  guildId: string,
): Promise<
  | { ok: true; commands: BridgeDreamCommand[]; slashCount: number; maxSlash: number }
  | { ok: false; error: string; status: number }
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const [commands, slashCount] = await Promise.all([
    listDreamCommands(guildId),
    countSlashDreamCommands(guildId),
  ]);
  return {
    ok: true,
    commands: commands.map(serializeCommand),
    slashCount,
    maxSlash: MAX_SLASH_DREAM_COMMANDS,
  };
}

export async function getBridgeDreamCommand(
  configManager: ConfigManager,
  guildId: string,
  name: string,
): Promise<{ ok: true; command: BridgeDreamCommand } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const command = await getDreamCommand(guildId, name);
  if (!command) return { ok: false, error: `No command named ${normalizeCommandName(name)}.`, status: 404 };
  return { ok: true, command: serializeCommand(command) };
}

export async function createBridgeDreamCommand(
  client: Client,
  configManager: ConfigManager,
  guildId: string,
  input: { userId: string; name: string; source: string; minLevel?: number },
): Promise<{ ok: true; command: BridgeDreamCommand } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  const name = normalizeCommandName(input.name ?? "");
  if (!isValidCommandName(name)) {
    return {
      ok: false,
      error: "Use 1–32 characters: lowercase letters, numbers, and underscores only.",
      status: 400,
    };
  }
  if (isReservedCommandName(name)) {
    return {
      ok: false,
      error: `${name} is reserved by a built-in Dreamliner command.`,
      status: 400,
    };
  }

  const existing = await getDreamCommand(guildId, name);
  if (existing) {
    return { ok: false, error: `A command named ${name} already exists.`, status: 409 };
  }

  const sourceCheck = validateSource(input.source);
  if (!sourceCheck.ok) return sourceCheck;

  const slashCount = await countSlashDreamCommands(guildId);
  if (slashCount >= MAX_SLASH_DREAM_COMMANDS) {
    return {
      ok: false,
      error: `This server already has ${MAX_SLASH_DREAM_COMMANDS} slash Dreamcode commands (max ${DREAM_SLASH_CAP}). Remove one first.`,
      status: 400,
    };
  }

  const minLevel = Math.max(0, Math.min(9999, Math.floor(Number(input.minLevel ?? 0) || 0)));
  const created = await createDreamCommand({
    guildId,
    name,
    source: sourceCheck.source,
    triggerType: "slash",
    minLevel,
    createdBy: input.userId,
  });

  try {
    await syncGuildDreamSlashCommands(client, guildId);
  } catch (error) {
    console.error("[bridge] dream command slash sync failed after create:", error);
    return {
      ok: false,
      error: "Command saved, but Discord guild slash sync failed. Restart the bot or retry save.",
      status: 502,
    };
  }

  return { ok: true, command: serializeCommand(created) };
}

export async function updateBridgeDreamCommand(
  client: Client,
  configManager: ConfigManager,
  guildId: string,
  name: string,
  input: { source: string; minLevel?: number },
): Promise<{ ok: true; command: BridgeDreamCommand } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  const normalized = normalizeCommandName(name);
  const existing = await getDreamCommand(guildId, normalized);
  if (!existing) {
    return { ok: false, error: `No command named ${normalized}.`, status: 404 };
  }
  if (isReservedCommandName(normalized)) {
    return {
      ok: false,
      error: `${normalized} is reserved by a built-in Dreamliner command.`,
      status: 400,
    };
  }

  const sourceCheck = validateSource(input.source);
  if (!sourceCheck.ok) return sourceCheck;

  const wasSlash = existing.triggerType === "slash";
  if (!wasSlash) {
    const slashCount = await countSlashDreamCommands(guildId);
    if (slashCount >= MAX_SLASH_DREAM_COMMANDS) {
      return {
        ok: false,
        error: `This server already has ${MAX_SLASH_DREAM_COMMANDS} slash Dreamcode commands (max ${DREAM_SLASH_CAP}). Remove one first.`,
        status: 400,
      };
    }
  }

  const patch: { source: string; triggerType: "slash"; minLevel?: number } = {
    source: sourceCheck.source,
    triggerType: "slash",
  };
  if (input.minLevel !== undefined) {
    patch.minLevel = Math.max(0, Math.min(9999, Math.floor(Number(input.minLevel) || 0)));
  }

  const updated = await updateDreamCommand(guildId, normalized, patch);
  if (!updated) {
    return { ok: false, error: `No command named ${normalized}.`, status: 404 };
  }

  try {
    await syncGuildDreamSlashCommands(client, guildId);
  } catch (error) {
    console.error("[bridge] dream command slash sync failed after update:", error);
    return {
      ok: false,
      error: "Command updated, but Discord guild slash sync failed. Restart the bot or retry save.",
      status: 502,
    };
  }

  return { ok: true, command: serializeCommand(updated) };
}

export async function deleteBridgeDreamCommand(
  client: Client,
  configManager: ConfigManager,
  guildId: string,
  name: string,
): Promise<{ ok: true; command: BridgeDreamCommand } | { ok: false; error: string; status: number }> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;

  const deleted = await deleteDreamCommand(guildId, name);
  if (!deleted) {
    return { ok: false, error: `No command named ${normalizeCommandName(name)}.`, status: 404 };
  }

  try {
    await syncGuildDreamSlashCommands(client, guildId);
  } catch (error) {
    console.error("[bridge] dream command slash sync failed after delete:", error);
    return {
      ok: false,
      error: "Command deleted, but Discord guild slash sync failed. Restart the bot to clear stale slash commands.",
      status: 502,
    };
  }

  return { ok: true, command: serializeCommand(deleted) };
}
