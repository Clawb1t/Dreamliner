import type { Client } from "discord.js";
import { CommandProgramError, validateProgram, type CommandProgram } from "../plugins/dream_commands/functions/program.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import type { ConfigManager } from "../config/manager.js";
import {
  countDreamCommands,
  createDreamCommand,
  deleteDreamCommand,
  getDreamCommand,
  isValidCommandName,
  listDreamCommands,
  MAX_DREAM_COMMANDS,
  normalizeCommandName,
  updateDreamCommand,
  type DreamCommandRow,
} from "../plugins/dream_commands/functions/store.js";
import {
  DREAM_COMMAND_CAP,
  isReservedCommandName,
  syncGuildDreamSlashCommands,
} from "../plugins/dream_commands/functions/guildSlash.js";

export type BridgeDreamCommand = {
  guildId: string;
  name: string;
  program: CommandProgram;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
};

function serializeCommand(row: DreamCommandRow): BridgeDreamCommand {
  return {
    guildId: row.guildId,
    name: row.name,
    program: row.program,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    enabled: row.enabled,
  };
}

export type CommandProgramValidation =
  | { ok: true; program: CommandProgram }
  | { ok: false; error: string; status: number };

function validateProgramInput(input: unknown): CommandProgramValidation {
  try {
    return { ok: true, program: validateProgram(input) };
  } catch (err) {
    const message = err instanceof CommandProgramError ? err.message : "Invalid command.";
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
  | { ok: true; commands: BridgeDreamCommand[]; count: number; maxCommands: number }
  | { ok: false; error: string; status: number }
> {
  const plugin = await assertPluginEnabled(configManager, guildId);
  if (!plugin.ok) return plugin;
  const [commands, count] = await Promise.all([
    listDreamCommands(guildId),
    countDreamCommands(guildId),
  ]);
  return {
    ok: true,
    commands: commands.map(serializeCommand),
    count,
    maxCommands: MAX_DREAM_COMMANDS,
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
  input: { userId: string; name: string; program: unknown },
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

  const programCheck = validateProgramInput(input.program);
  if (!programCheck.ok) return programCheck;

  const count = await countDreamCommands(guildId);
  if (count >= MAX_DREAM_COMMANDS) {
    return {
      ok: false,
      error: `This server already has ${MAX_DREAM_COMMANDS} custom commands (max ${DREAM_COMMAND_CAP}). Remove one first.`,
      status: 400,
    };
  }

  const created = await createDreamCommand({
    guildId,
    name,
    program: programCheck.program,
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
  input: { program: unknown },
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

  const programCheck = validateProgramInput(input.program);
  if (!programCheck.ok) return programCheck;

  const updated = await updateDreamCommand(guildId, normalized, { program: programCheck.program });
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
