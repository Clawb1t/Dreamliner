import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { interpolateTokens, type CommandProgram, type CommandTokenKey } from "./program.js";
import { isReservedCommandName } from "./guildSlash.js";
import { getDreamCommand, type DreamCommandRow } from "./store.js";

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

export function formatTriggerLabel(row: DreamCommandRow): string {
  return `/${row.name}`;
}

function buildTokens(interaction: ChatInputCommandInteraction): Record<CommandTokenKey, string> {
  return {
    user: interaction.user.username,
    mention: `<@${interaction.user.id}>`,
    server: interaction.guild?.name ?? "",
    channel: interaction.channel && "toString" in interaction.channel ? interaction.channel.toString() : "",
  };
}

function pickContent(program: CommandProgram): string {
  if (program.random && program.variants.length > 0) {
    return program.variants[Math.floor(Math.random() * program.variants.length)]!;
  }
  return program.content;
}

function buildEmbed(program: CommandProgram, tokens: Record<CommandTokenKey, string>): EmbedBuilder {
  const e = program.embed;
  const embed = new EmbedBuilder();
  if (e.title.trim()) embed.setTitle(interpolateTokens(e.title, tokens).slice(0, 256));
  if (e.titleUrl.trim()) embed.setURL(e.titleUrl);
  if (e.description.trim()) embed.setDescription(interpolateTokens(e.description, tokens).slice(0, 4096));
  if (e.color !== null) embed.setColor(e.color);
  if (e.thumbnailUrl.trim()) embed.setThumbnail(e.thumbnailUrl);
  if (e.imageUrl.trim()) embed.setImage(e.imageUrl);
  if (e.authorName.trim()) {
    embed.setAuthor({
      name: interpolateTokens(e.authorName, tokens).slice(0, 256),
      iconURL: e.authorIconUrl.trim() || undefined,
      url: e.authorUrl.trim() || undefined,
    });
  }
  if (e.footerText.trim()) embed.setFooter({ text: interpolateTokens(e.footerText, tokens).slice(0, 2048) });
  if (e.timestamp) embed.setTimestamp();
  return embed;
}

/**
 * Handle a guild-scoped custom slash command: always exactly one reply, text or embed.
 * Returns true if this interaction was claimed as a custom command.
 */
export async function handleDreamCommandSlash(
  interaction: ChatInputCommandInteraction,
  configManager: ConfigManager,
): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) return false;

  const command = await getDreamCommand(interaction.guildId, interaction.commandName);
  if (!command || !command.enabled) return false;
  // Failsafe: never claim a built-in bot command name as a custom command.
  if (isReservedCommandName(command.name)) return false;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "dream_commands")) {
    await interaction.reply({ content: "Custom commands are disabled in this server.", ephemeral: true }).catch(() => null);
    return true;
  }

  if (rateLimited(interaction.guildId, interaction.user.id)) {
    await interaction
      .reply({ content: "You're using custom commands too quickly. Try again in a moment.", ephemeral: true })
      .catch(() => null);
    return true;
  }

  try {
    const tokens = buildTokens(interaction);
    const program = command.program;
    if (program.responseType === "embed") {
      await interaction.reply({ embeds: [buildEmbed(program, tokens)], ephemeral: program.ephemeral });
    } else {
      const content = interpolateTokens(pickContent(program), tokens);
      await interaction.reply({ content, ephemeral: program.ephemeral });
    }

    const { trackCommandUsage } = await import("../../stats/functions/commandUsage.js");
    trackCommandUsage(interaction.guildId, command.name);
  } catch (error) {
    console.error(`[dream_commands] slash /${command.name} error:`, error);
    const text = "Custom command failed to run.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: text }).catch(() => null);
    } else {
      await interaction.reply({ content: text, ephemeral: true }).catch(() => null);
    }
  }

  return true;
}
