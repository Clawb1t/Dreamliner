import { REST, Routes, SlashCommandBuilder, type Client } from "discord.js";
import { getAllSlashCommands } from "../../availablePlugins.js";
import { listEnabledDreamCommands, type DreamCommandRow } from "./store.js";

/** Dreamliner allows at most this many custom commands per server (product limit). */
export const DREAM_COMMAND_CAP = 10;

const reservedNamesCache = new Set<string>();

/** Built-in Dreamliner slash command names (and a few fixed reserves). */
export function getReservedCommandNames(): Set<string> {
  if (reservedNamesCache.size === 0) {
    for (const cmd of getAllSlashCommands()) {
      reservedNamesCache.add(cmd.data.name);
    }
    // Always reserved even if plugin load order changes.
    reservedNamesCache.add("command");
    reservedNamesCache.add("help");
  }
  return reservedNamesCache;
}

/** True when a custom command name would collide with a built-in bot command. */
export function isReservedCommandName(name: string): boolean {
  return getReservedCommandNames().has(name.trim().toLowerCase());
}

function buildGuildCommandBody(rows: DreamCommandRow[]) {
  return rows
    .filter((row) => !isReservedCommandName(row.name))
    .slice(0, DREAM_COMMAND_CAP)
    .map((row) => {
      const description = row.program.description?.trim() || `Custom command: /${row.name}`;
      return new SlashCommandBuilder()
        .setName(row.name)
        .setDescription(description.slice(0, 100))
        .toJSON();
    });
}

export async function syncGuildDreamSlashCommands(client: Client, guildId: string): Promise<number> {
  const clientId = client.application?.id ?? client.user?.id;
  if (!clientId) {
    console.warn(`[dream_commands] Cannot sync guild slash commands for ${guildId}: missing application id`);
    return 0;
  }

  const token = client.token;
  if (!token) {
    console.warn(`[dream_commands] Cannot sync guild slash commands for ${guildId}: missing token`);
    return 0;
  }

  const rows = await listEnabledDreamCommands(guildId);
  const body = buildGuildCommandBody(rows);
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  return body.length;
}

export async function syncAllGuildDreamSlashCommands(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      await syncGuildDreamSlashCommands(client, guild.id);
    } catch (error) {
      console.error(`[dream_commands] Failed to sync guild commands for ${guild.id}:`, error);
    }
  }
}
