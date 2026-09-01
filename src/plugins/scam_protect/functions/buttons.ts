import type { ButtonInteraction } from "discord.js";
import { resultReply, guildResultOptions } from "../../../core/responses.js";
import { configManager } from "../../../config/manager.js";
import { SCAM_PROTECT_STATS_PREFIX } from "../constants.js";
import { countScamProtectCatches } from "./stats.js";
import { isScamProtectEnabled } from "./ensure.js";

export { SCAM_PROTECT_STATS_PREFIX };

export async function handleScamProtectButtonInteraction(
  interaction: ButtonInteraction,
): Promise<boolean> {
  if (interaction.customId !== SCAM_PROTECT_STATS_PREFIX) return false;
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(
      resultReply("Server only", "Use this button in a server.", true, {
        client: interaction.client,
        tone: "error",
      }),
    );
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!isScamProtectEnabled(guildConfig)) {
    await interaction.reply(
      resultReply(
        "Disabled",
        "Scam Protect is not enabled on this server.",
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "warning" }),
      ),
    );
    return true;
  }

  const count = await countScamProtectCatches(interaction.guildId);
  const noun = count === 1 ? "account" : "accounts";
  await interaction.reply(
    resultReply(
      "Scam Protect",
      `Dreamliner has softbanned **${count}** ${noun} that posted in this channel.`,
      true,
      guildResultOptions(interaction.client, guildConfig, {
        tone: "neutral",
        emoji: "<:icons_ban:1544417486177308742>",
      }),
    ),
  );
  return true;
}
