import {
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type ButtonInteraction,
  type GuildMember,
} from "discord.js";
import { guildResultOptions, resultReply } from "../../../core/responses.js";
import { configManager } from "../../../config/manager.js";
import { parseComponentEmoji } from "../../../core/emoji.js";

export const EXPAND_DELETE_PREFIX = "utility:expand:del:";

const DELETE_EMOJI = "<:dl_delete:1540811399993757816>";

export function expandDeleteCustomId(requesterId: string): string {
  return `${EXPAND_DELETE_PREFIX}${requesterId}`;
}

export function parseExpandDeleteRequesterId(customId: string): string | null {
  if (!customId.startsWith(EXPAND_DELETE_PREFIX)) return null;
  const requesterId = customId.slice(EXPAND_DELETE_PREFIX.length);
  return /^\d{17,20}$/.test(requesterId) ? requesterId : null;
}

/** Emoji-only, gray delete button attached to expanded message-link mirrors. */
export function buildExpandDeleteButton(requesterId: string): ButtonBuilder {
  const button = new ButtonBuilder()
    .setCustomId(expandDeleteCustomId(requesterId))
    .setStyle(ButtonStyle.Secondary);
  const emoji = parseComponentEmoji(DELETE_EMOJI);
  if (emoji) button.setEmoji(emoji);
  return button;
}

export async function handleExpandDeleteButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  const requesterId = parseExpandDeleteRequesterId(interaction.customId);
  if (!requesterId) return false;

  if (!interaction.inGuild() || !interaction.guildId) return true;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  const member = interaction.member as GuildMember | null;
  const canManageMessages =
    !!member && !!interaction.channel && member.permissionsIn(interaction.channel).has(PermissionFlagsBits.ManageMessages);

  if (interaction.user.id !== requesterId && !canManageMessages) {
    await interaction.reply(
      resultReply(
        "Not your message",
        "Only the person who pasted the link or a moderator can delete this.",
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  await interaction.deferUpdate().catch(() => null);
  await interaction.message.delete().catch(() => null);

  return true;
}
