import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { WelcomeWaveButton } from "../../../config/schemas/welcome.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { configManager } from "../../../config/manager.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import { addWelcomeWave, getWelcomeJoinMessage } from "./store.js";
import { loadWelcomeConfig } from "./loadConfig.js";

/** Shared custom id; the waved welcome is identified by interaction.message.id. */
export const WELCOME_WAVE_CUSTOM_ID = "welcome:wave";
export const WELCOME_WAVE_PREFIX = "welcome:wave";
export const EARLY_LEAVE_MS = 24 * 60 * 60 * 1000;

function parseButtonEmoji(raw: string): string | { id: string; name?: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mention = trimmed.match(/^<(a?):([A-Za-z0-9_]+):(\d{5,20})>$/);
  if (mention) {
    return { id: mention[3]!, name: mention[2] };
  }
  if (/^\d{5,20}$/.test(trimmed)) {
    return { id: trimmed };
  }
  return trimmed;
}

export function waveButtonLabel(baseLabel: string, count: number): string {
  const label = baseLabel.trim() || "Wave";
  return count > 0 ? `${label} · ${count}` : label;
}

export function buildWaveButtonRow(
  wave: WelcomeWaveButton,
  count = 0,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(WELCOME_WAVE_CUSTOM_ID)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(waveButtonLabel(wave.label || "Wave", count));

  const emoji = parseButtonEmoji(wave.emoji || "👋");
  if (emoji) button.setEmoji(emoji);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
}

export async function handleWelcomeWaveButtonInteraction(
  interaction: ButtonInteraction,
): Promise<boolean> {
  if (interaction.customId !== WELCOME_WAVE_CUSTOM_ID) return false;

  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  const ephemeral = resolveEphemeral(guildConfig);
  const messageId = interaction.message.id;

  const tracked = await getWelcomeJoinMessage(messageId);
  if (!tracked || !tracked.waveEnabled) {
    await interaction.reply(
      resultReply(
        "Unavailable",
        "This wave button is no longer active.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
      ),
    );
    return true;
  }

  const result = await addWelcomeWave(messageId, interaction.user.id);
  if (!result.ok) {
    if (result.reason === "duplicate") {
      await interaction.reply(
        resultReply(
          "Already waved",
          "You've already waved on this welcome.",
          ephemeral,
          guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
        ),
      );
      return true;
    }
    await interaction.reply(
      resultReply(
        "Unavailable",
        "This wave button is no longer active.",
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
      ),
    );
    return true;
  }

  const config = await loadWelcomeConfig(interaction.guildId!);
  const wave = config?.wave_button ?? { enabled: true, label: "Wave", emoji: "👋" };
  const row = buildWaveButtonRow(wave, result.row.waveCount);

  await interaction.update({ components: [row] }).catch(async () => {
    await interaction.deferUpdate().catch(() => null);
  });
  return true;
}
