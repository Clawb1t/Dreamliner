import { EmbedBuilder } from "discord.js";
import { baseEmbed, discordTs, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import type { EmojisConfig } from "../../../config/schemas/guild.js";
import type { Client, Guild } from "discord.js";
import type { TicketCategory } from "../../../config/schemas/tickets.js";
import type { TicketRecord } from "./tickets.js";

/**
 * Substitute {user}, {guild}, {category}, and {answer_1}..{answer_N} in a ticket
 * message template. {user} resolves to a real mention, but since this is only ever
 * used in embed descriptions/fields (not message `content`), Discord will not send
 * a ping for it — mentions inside embeds are inert.
 */
export function renderTicketTemplate(template: string, ticket: TicketRecord, guild: Guild, category: TicketCategory | undefined): string {
  let out = template
    .replace(/\{user\}/g, `<@${ticket.openerId}>`)
    .replace(/\{guild\}/g, guild.name)
    .replace(/\{category\}/g, category?.label ?? "Unknown");
  out = out.replace(/\{answer_(\d+)\}/g, (_match, indexStr: string) => {
    const index = Number(indexStr) - 1;
    return ticket.formResponses[index]?.answer ?? "";
  });
  return out;
}

export function buildTicketOpenedEmbed(
  ticket: TicketRecord,
  category: TicketCategory | undefined,
  guild: Guild,
  client: Client,
  emojis?: EmojisConfig,
): EmbedBuilder {
  const embed = setEmbedAuthor(baseEmbed(), `Ticket #${ticket.number}`, client, {
    tone: "success",
    emojis,
    emoji: "<:icons_ticket:1544417593191047179>",
  });
  const template = category?.welcome_message?.trim() || "Thanks for reaching out, {user}! Support will be with you shortly.";
  embed.setDescription(renderTicketTemplate(template, ticket, guild, category));
  embed.addFields(
    embedField("Opened by", `<@${ticket.openerId}>`, true),
    embedField("Category", category?.label ?? "Unknown", true),
    embedField("Priority", ticket.priority, true),
  );
  if (ticket.formResponses.length) {
    for (const answer of ticket.formResponses.slice(0, 5)) {
      embed.addFields(embedField(answer.label, answer.answer.slice(0, 1024) || "*(no answer)*"));
    }
  }
  return embed;
}

export function buildTicketClaimedEmbed(ticket: TicketRecord, staffId: string, client: Client, emojis?: EmojisConfig): EmbedBuilder {
  return setEmbedAuthor(baseEmbed(), `Ticket #${ticket.number} claimed`, client, {
    tone: "neutral",
    emojis,
    emoji: "<:icons_hammer:1544417299937763348>",
  }).setDescription(
    `<@${staffId}> is now handling this ticket.`,
  );
}

export function buildTranscriptEmbed(
  ticket: TicketRecord,
  guildName: string,
  messageCount: number,
  client: Client,
  emojis?: EmojisConfig,
  guildIconURL?: string | null,
): EmbedBuilder {
  const embed = setEmbedAuthor(baseEmbed(), `Ticket #${ticket.number} transcript`, client, {
    tone: "neutral",
    emojis,
    thumbnailURL: guildIconURL ?? undefined,
  });
  embed.setDescription(`Here's a copy of the conversation from your ticket in **${guildName}**. The full transcript is attached below.`);
  embed.addFields(
    embedField("Opened", discordTs(ticket.createdAt), true),
    embedField("Closed", ticket.closedAt ? discordTs(ticket.closedAt) : "—", true),
    embedField("Messages", String(messageCount), true),
  );
  return embed;
}

export function buildTicketClosedEmbed(
  ticket: TicketRecord,
  actorId: string,
  reason: string | null | undefined,
  client: Client,
  emojis?: EmojisConfig,
): EmbedBuilder {
  const embed = setEmbedAuthor(baseEmbed(), `Ticket #${ticket.number} closed`, client, {
    tone: "error",
    emojis,
    emoji: "<:icons_archive:1544417474823590008>",
  });
  embed.addFields(
    embedField("Closed by", `<@${actorId}>`, true),
    embedField("Opened", discordTs(ticket.createdAt), true),
  );
  if (reason?.trim()) embed.addFields(embedField("Reason", reason.slice(0, 1024)));
  return embed;
}
