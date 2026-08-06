import type { ChatInputCommandInteraction, Client, GuildMember, Message } from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getMemberLevel, resolvePluginConfig } from "../../../core/permissions.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { runDreamcode, type DreamValue } from "../../../dreamcode/index.js";
import { dreamCommandsDefaultOverrides } from "../defaultOverrides.js";
import { buildDreamGlobals } from "./context.js";
import { isReservedCommandName, slashPropsFromSource } from "./guildSlash.js";
import { createDiscordActionHost } from "./host.js";
import { resolveSlashArgValues } from "./slashArgs.js";
import { getDreamCommand, type DreamCommandRow } from "./store.js";
import { createSlashTrigger, messageAsTrigger, type DreamTrigger } from "./trigger.js";

const rateBuckets = new Map<string, number>();
const RATE_MS = 1500;

function rateLimited(guildId: string, userId: string): boolean {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const last = rateBuckets.get(key) ?? 0;
  if (now - last < RATE_MS) return true;
  rateBuckets.set(key, now);
  return false;
}

export function getDreamPrefix(pluginConfig: Record<string, unknown>): string {
  return typeof pluginConfig.prefix === "string" && pluginConfig.prefix.length > 0 ? pluginConfig.prefix : "d!";
}

export function formatTriggerLabel(row: DreamCommandRow, prefix: string): string {
  return row.triggerType === "slash" ? `/${row.name}` : `${prefix}${row.name}`;
}

async function executeDreamCommand(input: {
  command: DreamCommandRow;
  member: GuildMember;
  guildConfig: GuildConfig;
  argText: string;
  trigger: DreamTrigger;
  client: Client;
  sourceMessage?: Message;
  namedArgs?: Record<string, DreamValue>;
}): Promise<{ ok: true } | { ok: false; kind: "level" | "rate" | "error"; message: string }> {
  const { command, member, guildConfig, argText, trigger, client, sourceMessage, namedArgs } = input;
  const level = getMemberLevel(member, guildConfig.levels);
  if (level < command.minLevel) {
    return {
      ok: false,
      kind: "level",
      message: `You need permission level **${command.minLevel}** or higher to run this command.`,
    };
  }

  if (rateLimited(member.guild.id, member.id)) {
    return {
      ok: false,
      kind: "rate",
      message: "You're using Dreamcode commands too quickly. Try again in a moment.",
    };
  }

  let globals;
  if (sourceMessage) {
    globals = buildDreamGlobals({
      message: sourceMessage,
      member,
      guildConfig,
      argText,
      namedArgs,
    });
  } else {
    // Synthesize a message-like object for slash invocations (arg tokens still parsed).
    const synthetic = {
      id: trigger.id,
      content: trigger.content,
      channel: trigger.channel,
      author: member.user,
      member,
      guild: member.guild,
      client,
      createdAt: trigger.createdAt,
      pinned: trigger.pinned,
      url: trigger.url,
      mentions: {
        users: { keys: () => [][Symbol.iterator](), get: () => undefined },
        roles: { keys: () => [][Symbol.iterator]() },
        channels: { keys: () => [][Symbol.iterator]() },
        members: { get: () => undefined },
      },
    } as unknown as Message;
    globals = buildDreamGlobals({
      message: synthetic,
      member,
      guildConfig,
      argText,
      namedArgs,
    });
  }

  globals.trigger = {
    __type: "message",
    id: trigger.id,
    content: trigger.content,
    channelId: trigger.channel.id,
    authorId: trigger.author.id,
    createdAt: trigger.createdAt.getTime(),
    pinned: trigger.pinned,
    url: trigger.url,
  };

  const host = createDiscordActionHost({
    client,
    guild: member.guild,
    guildConfig,
    actor: member,
    trigger,
  });

  const result = await runDreamcode(command.source, { globals, host });
  if (!result.ok) {
    return {
      ok: false,
      kind: "error",
      message: result.aborted ? result.message : result.error.message,
    };
  }
  return { ok: true };
}

export async function handleDreamCommandMessage(message: Message, configManager: ConfigManager): Promise<void> {
  if (!message.guild || !message.member || message.author.bot) return;
  if (!message.content || message.content.includes("\n")) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "dream_commands")) return;

  const pluginConfig = resolvePluginConfig(
    guildConfig,
    "dream_commands",
    dreamCommandsDefaultOverrides,
    message.member,
    message.channel.id,
    message.channel.isTextBased() && "parentId" in message.channel ? message.channel.parentId : null,
  );

  const prefix = getDreamPrefix(pluginConfig);
  if (!message.content.startsWith(prefix)) return;

  const rest = message.content.slice(prefix.length).trimStart();
  if (!rest) return;

  const space = rest.search(/\s/);
  const rawName = space === -1 ? rest : rest.slice(0, space);
  const argText = space === -1 ? "" : rest.slice(space + 1).trim();
  if (!rawName) return;

  const command = await getDreamCommand(message.guild.id, rawName);
  if (!command || !command.enabled || command.triggerType !== "prefix") return;
  // Failsafe: never run Dreamcode under a built-in bot command name.
  if (isReservedCommandName(command.name)) return;

  const outcome = await executeDreamCommand({
    command,
    member: message.member,
    guildConfig,
    argText,
    trigger: messageAsTrigger(message),
    client: message.client,
    sourceMessage: message,
  });

  if (!outcome.ok) {
    if (outcome.kind === "level") {
      await message.react("❌").catch(() => null);
      return;
    }
    if (outcome.kind === "rate") {
      await message.react("⏳").catch(() => null);
      return;
    }
    await message.reply({ content: `Dreamcode error: ${outcome.message.slice(0, 500)}` }).catch(() => null);
  }
}

/**
 * Handle a guild-scoped Dreamcode slash command.
 * Returns true if this interaction was claimed as a dreamcode command.
 */
export async function handleDreamCommandSlash(
  interaction: ChatInputCommandInteraction,
  configManager: ConfigManager,
): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) return false;

  const command = await getDreamCommand(interaction.guildId, interaction.commandName);
  if (!command || !command.enabled || command.triggerType !== "slash") return false;
  // Failsafe: never claim a built-in bot command name as Dreamcode.
  if (isReservedCommandName(command.name)) return false;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "dream_commands")) {
    await interaction.reply({ content: "Dreamcode commands are disabled in this server.", ephemeral: true }).catch(() => null);
    return true;
  }

  const member =
    interaction.member && typeof interaction.member !== "string"
      ? (interaction.member as GuildMember)
      : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: "Could not resolve your member profile.", ephemeral: true }).catch(() => null);
    return true;
  }

  const slash = slashPropsFromSource(command.source);
  const namedArgs =
    slash.args.length > 0
      ? await resolveSlashArgValues(interaction, slash.args, guildConfig)
      : undefined;
  const argText =
    slash.noargs || slash.args.length > 0
      ? ""
      : interaction.options.getString("args")?.trim() ?? "";

  try {
    const trigger = await createSlashTrigger(interaction, command.name, argText, {
      ephemeral: slash.ephemeral === true,
    });
    const outcome = await executeDreamCommand({
      command,
      member,
      guildConfig,
      argText,
      trigger,
      client: interaction.client,
      namedArgs,
    });

    if (!outcome.ok) {
      const text =
        outcome.kind === "error"
          ? `Dreamcode error: ${outcome.message.slice(0, 500)}`
          : outcome.message;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: text }).catch(async () => {
          await interaction.followUp({ content: text, ephemeral: true }).catch(() => null);
        });
      } else {
        await interaction.reply({ content: text, ephemeral: true }).catch(() => null);
      }
      return true;
    }

    // Script never used reply/edit — drop the deferred placeholder.
    if (!trigger.didReply() && interaction.deferred) {
      await interaction.deleteReply().catch(() => null);
    }
  } catch (error) {
    console.error(`[dream_commands] slash /${command.name} error:`, error);
    const text = "Dreamcode command failed to run.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: text }).catch(() => null);
    } else {
      await interaction.reply({ content: text, ephemeral: true }).catch(() => null);
    }
  }

  return true;
}
