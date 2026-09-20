import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { buildEmbed } from "../../persist/functions/messageBuilder.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { buildGiveawayClaimCustomId, buildGiveawayEnterCustomId } from "./customIds.js";
import type { Giveaway } from "./store.js";

const DEFAULT_COLOR = 0x5662f5;

function parseButtonStyle(style: string): ButtonStyle {
  switch (style) {
    case "secondary":
      return ButtonStyle.Secondary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Primary;
  }
}

function summarizeRequirements(giveaway: Giveaway): string[] {
  const lines: string[] = [];
  if (giveaway.requireRoleIds.length > 0) {
    const mode = giveaway.requireRoleMode === "all" ? "all of" : "any of";
    lines.push(`${mode} ${giveaway.requireRoleIds.map((id) => `<@&${id}>`).join(", ")}`);
  }
  if (giveaway.minAccountAgeDays > 0) {
    lines.push(`account age ${giveaway.minAccountAgeDays}+ day(s)`);
  }
  if (giveaway.minJoinAgeDays > 0) {
    lines.push(`server member for ${giveaway.minJoinAgeDays}+ day(s)`);
  }
  return lines;
}

/** Builds the live/active giveaway embed: the dashboard-authored embed plus a countdown, entry
 *  count, and requirements summary appended underneath. Unlike Persist/Tickets, a giveaway's
 *  embed is never optional (there's no "plain text" giveaway post), so `enabled` is forced on
 *  here regardless of what's stored, in case a stray row somehow has it off. */
export function buildGiveawayEmbed(giveaway: Giveaway, entryCount: number, guild: Guild): EmbedBuilder {
  const base = buildEmbed(
    { ...giveaway.embedConfig, enabled: true },
    {
      client: guild.client,
      guild,
      channel: undefined as unknown as GuildTextBasedChannel,
    },
  );
  const embed = base ?? new EmbedBuilder().setColor(giveaway.embedConfig.color ?? DEFAULT_COLOR);

  const fallbackTitle = (giveaway.title || giveaway.prize).trim();
  if (!embed.data.title && fallbackTitle) embed.setTitle(fallbackTitle);

  const lines: string[] = [];
  if (embed.data.description) lines.push(embed.data.description);
  lines.push(`**Prize:** ${giveaway.prize}`);
  lines.push(
    giveaway.status === "active"
      ? `**Ends:** <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>`
      : `**Status:** ${giveaway.status}`,
  );
  lines.push(`**Entries:** ${entryCount}`);

  const requirements = summarizeRequirements(giveaway);
  if (requirements.length) lines.push(`**Requirements:** ${requirements.join(", ")}`);

  embed.setDescription(lines.join("\n"));
  return embed;
}

export function buildGiveawayComponents(giveaway: Giveaway, entryCount: number): ActionRowBuilder<ButtonBuilder>[] {
  if (giveaway.entryMethod !== "button") return [];

  const button = new ButtonBuilder()
    .setCustomId(buildGiveawayEnterCustomId(giveaway.id))
    .setLabel(`${giveaway.buttonLabel} (${entryCount})`.slice(0, 80))
    .setStyle(parseButtonStyle(giveaway.buttonStyle))
    .setDisabled(giveaway.status !== "active");

  const emoji = parseComponentEmoji(giveaway.buttonEmoji);
  if (emoji) button.setEmoji(emoji);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(button)];
}

export function buildGiveawayEndedEmbed(giveaway: Giveaway, winnerUserIds: string[]): EmbedBuilder {
  const winnerLine = winnerUserIds.length ? winnerUserIds.map((id) => `<@${id}>`).join(", ") : "No valid entries.";
  return new EmbedBuilder()
    .setColor(giveaway.embedConfig.color ?? DEFAULT_COLOR)
    .setTitle(`${giveaway.title || giveaway.prize} (Ended)`)
    .setDescription([`**Prize:** ${giveaway.prize}`, `**Winner(s):** ${winnerLine}`].join("\n"));
}

export function buildGiveawayCancelledEmbed(giveaway: Giveaway): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(giveaway.embedConfig.color ?? DEFAULT_COLOR)
    .setTitle(`${giveaway.title || giveaway.prize} (Cancelled)`)
    .setDescription(`**Prize:** ${giveaway.prize}\nThis giveaway was cancelled.`);
}

const CLAIM_EMOJI = "<:icons_trophy:1544418249721126922>";

export function buildClaimComponents(giveawayId: number, winnerRowId: number): ActionRowBuilder<ButtonBuilder>[] {
  const button = new ButtonBuilder()
    .setCustomId(buildGiveawayClaimCustomId(giveawayId, winnerRowId))
    .setLabel("Claim prize")
    .setStyle(ButtonStyle.Success);
  const emoji = parseComponentEmoji(CLAIM_EMOJI);
  if (emoji) button.setEmoji(emoji);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(button)];
}
