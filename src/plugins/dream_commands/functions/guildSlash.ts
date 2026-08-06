import { REST, Routes, SlashCommandBuilder, type Client } from "discord.js";
import { compileDreamcode } from "../../../dreamcode/index.js";
import type { Program, SlashArgDef, SlashProps } from "../../../dreamcode/types.js";
import { getAllSlashCommands } from "../../availablePlugins.js";
import { listSlashDreamCommands, type DreamCommandRow } from "./store.js";

/** Discord allows at most this many dreamcode guild slash commands per server (product limit). */
export const DREAM_SLASH_CAP = 10;

const reservedNamesCache = new Set<string>();

export function getReservedSlashNames(): Set<string> {
  if (reservedNamesCache.size === 0) {
    for (const cmd of getAllSlashCommands()) {
      reservedNamesCache.add(cmd.data.name);
    }
    reservedNamesCache.add("command");
  }
  return reservedNamesCache;
}

export function isReservedSlashName(name: string): boolean {
  return getReservedSlashNames().has(name.trim().toLowerCase());
}

/** Compile source for trigger + slash meta; invalid source falls back to empty slash props. */
export function programMetaFromSource(source: string): Pick<Program, "trigger" | "slash"> {
  try {
    const program = compileDreamcode(source);
    return { trigger: program.trigger, slash: program.slash };
  } catch {
    return { trigger: null, slash: { args: [] } };
  }
}

/** Read `@slash` props from source; invalid source falls back to defaults. */
export function slashPropsFromSource(source: string): SlashProps {
  return programMetaFromSource(source).slash;
}

function addTypedOption(builder: SlashCommandBuilder, arg: SlashArgDef): void {
  const desc = (arg.description || arg.name).slice(0, 100);
  const required = arg.required === true;

  switch (arg.type) {
    case "string":
      builder.addStringOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    case "integer":
      builder.addIntegerOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    case "number":
      builder.addNumberOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    case "boolean":
      builder.addBooleanOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    case "user":
      builder.addUserOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    case "channel":
      builder.addChannelOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    case "role":
      builder.addRoleOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    case "mentionable":
      builder.addMentionableOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    case "attachment":
      builder.addAttachmentOption((o) => o.setName(arg.name).setDescription(desc).setRequired(required));
      break;
    default:
      break;
  }
}

function buildGuildCommandBody(rows: DreamCommandRow[]) {
  return rows.slice(0, DREAM_SLASH_CAP).map((row) => {
    const slash = slashPropsFromSource(row.source);
    const description = slash.description?.trim() || `Dreamcode: /${row.name}`;
    const builder = new SlashCommandBuilder()
      .setName(row.name)
      .setDescription(description.slice(0, 100));

    if (slash.noargs) {
      // no options
    } else if (slash.args.length > 0) {
      for (const arg of slash.args) {
        addTypedOption(builder, arg);
      }
    } else {
      // Legacy freeform string bag when no typed args are declared
      builder.addStringOption((o) =>
        o
          .setName("args")
          .setDescription("Optional arguments passed to the Dreamcode script")
          .setRequired(false),
      );
    }

    return builder.toJSON();
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

  const rows = await listSlashDreamCommands(guildId);
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
