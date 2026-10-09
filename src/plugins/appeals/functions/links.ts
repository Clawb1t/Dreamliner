import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type MessageActionRowComponentBuilder } from "discord.js";
import { APPEAL_EMOJIS } from "../../../config/schemas/appeals.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getAppealsUrl } from "../../../core/docsUrl.js";
import { activeAppealsConfig, ruleFor } from "./config.js";

/**
 * The Appeal button added to infraction DMs (infractions and automod), linking straight to that
 * infraction on the server's appeals page. Empty when appeals are off, paused, the button is
 * turned off, or that infraction type can't be appealed.
 */
export function appealDmComponents(
  guildConfig: GuildConfig,
  guildId: string,
  record: { id: number; type: string },
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const config = activeAppealsConfig(guildConfig);
  if (!config?.accepting || !config.dm_button.enabled) return [];
  if (!ruleFor(config, record.type)?.enabled) return [];
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel((config.dm_button.label.trim() || "Appeal").slice(0, 80))
        .setEmoji(APPEAL_EMOJIS.appeal)
        .setStyle(ButtonStyle.Link)
        .setURL(getAppealsUrl(guildId, record.id)),
    ),
  ];
}
